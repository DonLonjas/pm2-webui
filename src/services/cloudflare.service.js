const fs = require('fs')
const os = require('os')
const path = require('path')
const yaml = require('yamljs')

const CLOUDFLARED_DIR = process.env.CLOUDFLARED_DIR || path.join(os.homedir(), '.cloudflared')
const CERT_PATH = path.join(CLOUDFLARED_DIR, 'cert.pem')

function getCredentials() {
    const certContent = fs.readFileSync(CERT_PATH, 'utf8')
    const match = certContent.match(/-----BEGIN ARGO TUNNEL TOKEN-----\n([\s\S]+?)\n-----END ARGO TUNNEL TOKEN-----/)
    if (!match) throw new Error('No se pudo leer el token de cert.pem')
    const decoded = Buffer.from(match[1].trim(), 'base64').toString('utf8')
    const creds = JSON.parse(decoded)
    return creds
}

function parseHostnames(configContent) {
    const hostnames = []
    const lines = configContent.split('\n')
    for (const line of lines) {
        const match = line.match(/^\s*-\s*hostname:\s*(.+)/)
        if (match) {
            const host = match[1].trim()
            if (host && !hostnames.includes(host)) {
                hostnames.push(host)
            }
        }
    }
    return hostnames
}

function parseTunnelId(configContent) {
    const match = configContent.match(/^tunnel:\s*(.+)/m)
    if (!match) throw new Error('No se encontro tunnel ID en config.yml')
    return match[1].trim()
}

function parseIngress(configContent) {
    const parsed = yaml.parse(configContent)
    if (!parsed || !Array.isArray(parsed.ingress)) {
        throw new Error('No se encontro un bloque ingress valido en config.yml')
    }
    return parsed.ingress
}

async function getAccountId(zoneId, apiToken) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}`, {
        headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json'
        }
    })
    const data = await response.json()
    if (!data.success) {
        throw new Error('Error al obtener el account ID: ' + JSON.stringify(data.errors))
    }
    return data.result.account.id
}

// A named tunnel's ingress rules can be "remotely managed" (stored on Cloudflare's
// side, e.g. once anyone touches the tunnel's Public Hostname tab in the Zero Trust
// dashboard). When that happens cloudflared ignores the local config.yml ingress
// block entirely, no matter how many times it's restarted. Pushing the config
// through this API keeps the remote copy in sync with what's saved locally.
async function pushIngressConfig(configContent) {
    const creds = getCredentials()
    const { zoneID, apiToken } = creds
    const tunnelId = parseTunnelId(configContent)
    const ingress = parseIngress(configContent)
    const accountId = await getAccountId(zoneID, apiToken)

    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ config: { ingress, 'warp-routing': { enabled: false } } })
    })
    const data = await response.json()
    if (!data.success) {
        throw new Error('Error al actualizar el ingress remoto: ' + JSON.stringify(data.errors))
    }
    return { version: data.result.version, hostnames: ingress.filter(r => r.hostname).map(r => r.hostname) }
}

async function listDnsRecords(zoneId, apiToken) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?per_page=100`, {
        headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json'
        }
    })
    const data = await response.json()
    if (!data.success) {
        throw new Error('Error al listar DNS records: ' + JSON.stringify(data.errors))
    }
    return data.result || []
}

async function createDnsRecord(zoneId, apiToken, hostname, tunnelId) {
    const cnameTarget = `${tunnelId}.cfargotunnel.com`
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            type: 'CNAME',
            name: hostname,
            content: cnameTarget,
            ttl: 1,
            proxied: true
        })
    })
    const data = await response.json()
    if (!data.success) {
        const err = data.errors && data.errors[0]
        if (err && err.code === 81053) {
            return { hostname, status: 'exists', message: 'Ya existe' }
        }
        throw new Error(`Error al crear ${hostname}: ${JSON.stringify(data.errors)}`)
    }
    return { hostname, status: 'created', message: 'Creado', id: data.result.id }
}

async function deleteDnsRecord(zoneId, apiToken, recordId, hostname) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`, {
        method: 'DELETE',
        headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json'
        }
    })
    const data = await response.json()
    if (!data.success) {
        throw new Error(`Error al eliminar ${hostname}: ${JSON.stringify(data.errors)}`)
    }
    return { hostname, status: 'deleted', message: 'Eliminado' }
}

async function syncDnsFromConfig(configContent, options = {}) {
    const { deleteMissing = false } = options
    const creds = getCredentials()
    const { zoneID, apiToken } = creds
    const hostnames = parseHostnames(configContent)
    const tunnelId = parseTunnelId(configContent)

    if (hostnames.length === 0) {
        return { created: [], exists: [], deleted: [], message: 'No hay hostnames en el config' }
    }

    const existingRecords = await listDnsRecords(zoneID, apiToken)
    const tunnelCname = `${tunnelId}.cfargotunnel.com`
    const existingForTunnel = existingRecords.filter(r => r.type === 'CNAME' && r.content === tunnelCname)
    const existingHostnames = existingForTunnel.map(r => r.name)

    const results = { created: [], exists: [], deleted: [], errors: [] }

    for (const hostname of hostnames) {
        try {
            if (existingHostnames.includes(hostname)) {
                results.exists.push({ hostname, message: 'Ya existe' })
            } else {
                const result = await createDnsRecord(zoneID, apiToken, hostname, tunnelId)
                if (result.status === 'created') {
                    results.created.push(result)
                } else {
                    results.exists.push(result)
                }
            }
        } catch (err) {
            results.errors.push({ hostname, error: err.message })
        }
    }

    if (deleteMissing) {
        const toDelete = existingForTunnel.filter(r => !hostnames.includes(r.name))
        for (const record of toDelete) {
            try {
                const result = await deleteDnsRecord(zoneID, apiToken, record.id, record.name)
                results.deleted.push(result)
            } catch (err) {
                results.errors.push({ hostname: record.name, error: err.message })
            }
        }
    }

    return results
}

module.exports = {
    getCredentials,
    parseHostnames,
    parseTunnelId,
    parseIngress,
    getAccountId,
    pushIngressConfig,
    listDnsRecords,
    createDnsRecord,
    deleteDnsRecord,
    syncDnsFromConfig
}
