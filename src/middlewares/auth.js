function isApiRequest(ctx) {
    return ctx.path.startsWith('/api/') ||
        (ctx.get('Accept') && ctx.get('Accept').includes('application/json')) ||
        (ctx.get('X-Requested-With') === 'XMLHttpRequest');
}

const checkAuthentication = async (ctx, next) => {
    if(ctx.session.isAuthenticated){
        if (isApiRequest(ctx)) {
            ctx.status = 403;
            return ctx.body = { success: false, error: 'Already authenticated' };
        }
        return ctx.redirect('/apps')
    }
    await next()
}

const isAuthenticated = async (ctx, next) => {
    if(!ctx.session.isAuthenticated){
        if (isApiRequest(ctx)) {
            ctx.status = 401;
            return ctx.body = { success: false, error: 'Unauthorized' };
        }
        return ctx.redirect('/login')
    }
    await next()
}

module.exports = {
    isAuthenticated,
    checkAuthentication,
};