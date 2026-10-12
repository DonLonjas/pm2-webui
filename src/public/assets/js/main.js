async function pm2AppAction(appName, action){
    try {
        const response = await fetch(`/api/apps/${appName}/${action}`, {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
        });
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            if (response.status === 401 || response.url.includes('/login')) {
                window.location.href = '/login';
                return;
            }
        }
    } catch (err) {
        console.error('Error en pm2AppAction:', err);
    }
    location.reload();
}