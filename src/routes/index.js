const config = require('../config')
const fs = require('fs')
const os = require('os')
const path = require('path')
const RateLimit = require('koa2-ratelimit').RateLimit;
const router = require('@koa/router')();
const { listApps, describeApp, reloadApp, restartApp, stopApp } = require('../providers/pm2/api')
const { validateAdminUser } = require('../services/admin.service')
const  { readLogsReverse } = require('../utils/read-logs.util')
const { getCurrentGitBranch, getCurrentGitCommit } = require('../utils/git.util')
const { getEnvFileContent } = require('../utils/env.util')
const { isAuthenticated, checkAuthentication }= require('../middlewares/auth')
const { syncDnsFromConfig, pushIngressConfig } = require('../services/cloudflare.service')
const AnsiConverter = require('ansi-to-html');
const ansiConvert = new AnsiConverter();

const CLOUDFLARED_CONFIG_PATH = process.env.CLOUDFLARED_CONFIG_PATH || path.join(process.env.CLOUDFLARED_DIR || path.join(os.homedir(), '.cloudflared'), 'config.yml')

const loginRateLimiter = RateLimit.middleware({
    interval: 2*60*1000, // 2 minutes
    max: 100,
    prefixKey: '/login' // to allow the bdd to Differentiate the endpoint 
  });

router.get('/', async (ctx) => {
    return ctx.redirect('/login')
})

router.get('/login', loginRateLimiter, checkAuthentication, async (ctx) => {
    return await ctx.render('auth/login', {layout : false, login: { username: '', password:'', error: null }})
})

router.post('/login', loginRateLimiter, checkAuthentication, async (ctx) => {
    const { username, password } = ctx.request.body;
    try {
        await validateAdminUser(username, password)
        ctx.session.isAuthenticated = true;
        return ctx.redirect('/apps')
    }
    catch(err){
        return await ctx.render('auth/login', {layout : false, login: { username, password, error: err.message }})
    }
})

router.get('/apps', isAuthenticated, async (ctx) => {
    const apps =  await listApps()
    return await ctx.render('apps/dashboard', {
      apps
    });
});

router.get('/logout', (ctx)=>{
    ctx.session = null;
    return ctx.redirect('/login')
})

router.get('/apps/:appName', isAuthenticated, async (ctx) => {
    const { appName } = ctx.params
    let app =  await describeApp(appName)
    if(app){
        app.git_branch = await getCurrentGitBranch(app.pm2_env_cwd)
        app.git_commit = await getCurrentGitCommit(app.pm2_env_cwd)
        app.env_file = await getEnvFileContent(app.pm2_env_cwd)
        const stdout = await readLogsReverse({filePath: app.pm_out_log_path})
        const stderr = await readLogsReverse({filePath: app.pm_err_log_path})
        stdout.lines = stdout.lines.map(log => {
            return  ansiConvert.toHtml(log)
        }).join('<br/>')
        stderr.lines = stderr.lines.map(log => {
            return  ansiConvert.toHtml(log)
        }).join('<br/>')
        return await ctx.render('apps/app', {
            app,
            logs: {
                stdout,
                stderr
            }
        });
    }
    return ctx.redirect('/apps')
});

router.get('/api/apps/:appName/logs/:logType', isAuthenticated, async (ctx) => {
    const { appName, logType } = ctx.params
    const { linePerRequest, nextKey } = ctx.query
    if(logType !== 'stdout' && logType !== 'stderr'){
        return ctx.body = {
            'error': 'Log Type must be stdout or stderr'
        }
    }
    const app =  await describeApp(appName)
    const filePath = logType === 'stdout' ? app.pm_out_log_path: app.pm_err_log_path
    let logs = await readLogsReverse({filePath, nextKey})
    logs.lines = logs.lines.map(log => {
        return  ansiConvert.toHtml(log)
    }).join('<br/>')
    return ctx.body = {
        logs
    };
});

router.post('/api/apps/:appName/reload', isAuthenticated, async (ctx) => {
    try{
        let { appName } = ctx.params
        let apps =  await reloadApp(appName)
        if(Array.isArray(apps) && apps.length > 0){
            return ctx.body = {
                success: true
            }
        }
        return ctx.body = {
            success: false
        }
    }
    catch(err){
        return ctx.body = {
            'error':  err
        }
    }
});

router.post('/api/apps/:appName/restart', isAuthenticated,  async (ctx) => {
    try{
        let { appName } = ctx.params
        let apps =  await restartApp(appName)
        if(Array.isArray(apps) && apps.length > 0){
            return ctx.body = {
                success: true
            }
        }
        return ctx.body = {
            success: false
        }
    }
    catch(err){
        console.log(err)
        return ctx.body = {
            'error':  err
        }
    }
});

router.post('/api/apps/:appName/stop', isAuthenticated, async (ctx) => {
    try{
        let { appName } = ctx.params
        let apps =  await stopApp(appName)
        if(Array.isArray(apps) && apps.length > 0){
            return ctx.body = {
                success: true
            }
        }
        return ctx.body = {
            success: false
        }
    }
    catch(err){
        return ctx.body = {
            'error':  err
        }
    }
});

// Cloudflared Tunnel Config Editor
router.get('/tunnels', isAuthenticated, async (ctx) => {
    const configContent = fs.readFileSync(CLOUDFLARED_CONFIG_PATH, 'utf8')
    return await ctx.render('tunnels/config', {
        config: configContent,
        configPath: CLOUDFLARED_CONFIG_PATH,
        error: null,
        success: null
    });
});

router.post('/tunnels', isAuthenticated, async (ctx) => {
    const { config: newConfig } = ctx.request.body;
    let renderOpts = { config: newConfig, configPath: CLOUDFLARED_CONFIG_PATH, error: null, success: null };
    let dnsResults = null;
    try {
        fs.writeFileSync(CLOUDFLARED_CONFIG_PATH, newConfig, 'utf8');
        try {
            dnsResults = await syncDnsFromConfig(newConfig, { deleteMissing: false });
            console.log('[TUNNEL] DNS sync results:', JSON.stringify(dnsResults))
        } catch (dnsErr) {
            console.error('[TUNNEL] DNS sync failed:', dnsErr.message)
        }
        let ingressResult = null, ingressErr = null
        try {
            ingressResult = await pushIngressConfig(newConfig);
            console.log('[TUNNEL] Ingress push result:', JSON.stringify(ingressResult))
        } catch (err) {
            ingressErr = err.message
            console.error('[TUNNEL] Ingress push failed:', err.message)
        }
        let successMsg = 'Configuracion guardada. El tunnel se reiniciara en unos segundos...'
        if (dnsResults) {
            const created = (dnsResults.created || []).map(r => r.hostname).join(', ')
            const exists = (dnsResults.exists || []).map(r => r.hostname).join(', ')
            const errors = (dnsResults.errors || []).map(r => `${r.hostname}: ${r.error}`).join('; ')
            if (created) successMsg += `\nDNS creado: ${created}`
            if (exists) successMsg += `\nDNS ya existia: ${exists}`
            if (errors) successMsg += `\nErrores DNS: ${errors}`
        }
        if (ingressResult) successMsg += `\nIngress remoto actualizado (v${ingressResult.version}): ${ingressResult.hostnames.join(', ')}`
        if (ingressErr) successMsg += `\nError al actualizar ingress remoto: ${ingressErr}`
        renderOpts.success = successMsg
        renderOpts.dnsResults = dnsResults
        setTimeout(async () => {
            try {
                console.log('[TUNNEL] Restarting tunnel after config save (async)...')
                await restartApp('tunnel');
                console.log('[TUNNEL] Restart done after config save')
            } catch (err) {
                console.error('[TUNNEL] Async restart after save failed:', err)
            }
        }, 1500);
    } catch (err) {
        renderOpts.error = err.message || 'Error al guardar la configuracion'
    }
    return await ctx.render('tunnels/config', renderOpts);
});

router.get('/api/tunnels/config', isAuthenticated, async (ctx) => {
    try {
        const configContent = fs.readFileSync(CLOUDFLARED_CONFIG_PATH, 'utf8')
        ctx.body = { success: true, config: configContent }
    } catch (err) {
        ctx.status = 500
        ctx.body = { success: false, error: err.message }
    }
});

router.post('/api/tunnels/config', isAuthenticated, async (ctx) => {
    const { config: newConfig } = ctx.request.body;
    try {
        fs.writeFileSync(CLOUDFLARED_CONFIG_PATH, newConfig, 'utf8');
        ctx.body = { success: true, message: 'Configuración guardada' }
    } catch (err) {
        ctx.status = 500
        ctx.body = { success: false, error: err.message }
    }
});

router.post('/api/tunnels/restart', isAuthenticated, async (ctx) => {
    try {
        ctx.body = { success: true, message: 'Tunnel reiniciando...' }
        setTimeout(async () => {
            try {
                console.log('[TUNNEL] Restarting tunnel process via PM2 (async)...')
                const result = await restartApp('tunnel');
                console.log('[TUNNEL] Restart done, restart_time:', result && result[0] && result[0].restart_time)
            } catch (err) {
                console.error('[TUNNEL] Async restart failed:', err)
            }
        }, 500);
    } catch (err) {
        console.error('[TUNNEL] Restart failed:', err)
        ctx.status = 500
        ctx.body = { success: false, error: err.message || 'Unknown error' }
    }
});

router.post('/api/tunnels/sync-dns', isAuthenticated, async (ctx) => {
    try {
        const configContent = fs.readFileSync(CLOUDFLARED_CONFIG_PATH, 'utf8')
        const { deleteMissing } = ctx.request.body || {}
        const results = await syncDnsFromConfig(configContent, { deleteMissing: !!deleteMissing })
        ctx.body = { success: true, results }
    } catch (err) {
        console.error('[TUNNEL] DNS sync failed:', err)
        ctx.status = 500
        ctx.body = { success: false, error: err.message }
    }
});

router.post('/api/tunnels/sync-ingress', isAuthenticated, async (ctx) => {
    try {
        const configContent = fs.readFileSync(CLOUDFLARED_CONFIG_PATH, 'utf8')
        const result = await pushIngressConfig(configContent)
        ctx.body = { success: true, result }
    } catch (err) {
        console.error('[TUNNEL] Ingress push failed:', err)
        ctx.status = 500
        ctx.body = { success: false, error: err.message }
    }
});

router.post('/api/tunnels/save-and-sync', isAuthenticated, async (ctx) => {
    const { config: newConfig } = ctx.request.body;
    try {
        fs.writeFileSync(CLOUDFLARED_CONFIG_PATH, newConfig, 'utf8');
        const dnsResults = await syncDnsFromConfig(newConfig, { deleteMissing: false })
        const ingressResult = await pushIngressConfig(newConfig)
        ctx.body = { success: true, message: 'Config guardado, DNS e ingress sincronizados', dnsResults, ingressResult }
        setTimeout(async () => {
            try {
                console.log('[TUNNEL] Restarting tunnel after save-and-sync (async)...')
                await restartApp('tunnel');
                console.log('[TUNNEL] Restart done after save-and-sync')
            } catch (err) {
                console.error('[TUNNEL] Async restart failed:', err)
            }
        }, 1500);
    } catch (err) {
        console.error('[TUNNEL] Save and sync failed:', err)
        ctx.status = 500
        ctx.body = { success: false, error: err.message }
    }
});

module.exports = router;
