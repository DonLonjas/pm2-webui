### PM2 WebUI
Opensource Alternative to PM2 Plus

##### FEATURES
- Secure Login :white_check_mark:
- App Management :white_check_mark:
- Log Viewer :white_check_mark:
- Responsive UI :white_check_mark:
- Manual and Auto(Github webhooks) Deployment
- Environment Management

##### USAGE
```
git clone https://github.com/DonLonjas/pm2-webui
cd pm2-webui
npm install
cp env.example .env
npm run setup-admin-user (Required for login)
npm start
```
##### FOR DEVELOPMENT USE
```
npm run start:dev
```

##### ⚙️ Configuration / Variables de entorno
La aplicación carga las variables de entorno desde un archivo `.env` mediante [dotenv](https://www.npmjs.com/package/dotenv). El archivo `env.example` incluido en el repositorio es la plantilla de referencia: cópialo a `.env` y ajusta los valores.

> ⚠️ **NUNCA** subas el `.env` real al repositorio: contiene secretos (sesión, credenciales). Ya está ignorado en `.gitignore`.

| Variable | Descripción | Default o ejemplo |
| --- | --- | --- |
| `HOST` | Interfaz en la que escucha la web (`127.0.0.1` solo local, `0.0.0.0` accesible desde la red) | `127.0.0.1` |
| `PORT` | Puerto de escucha | `4343` |
| `APP_SESSION_SECRET` | Secreto para firmar la sesión. Debe ser único por instalación | `openssl rand -hex 32` |
| `APP_USERNAME` | Usuario admin para el login | `admin` |
| `APP_PASSWORD` | hash bcrypt de la contraseña del admin (generado con `npm run setup-admin-user`) | `$2a$10$...` |
| `SHOW_GIT_INFO` | Mostrar información de git en la interfaz | `true` |
| `SHOW_ENV_FILE` | Mostrar el contenido del archivo `.env` en la interfaz | `false` |
| `CLOUDFLARED_DIR` | Directorio donde cloudflared guarda `cert.pem` y su configuración | `/home/USUARIO/.cloudflared` |
| `CLOUDFLARED_CONFIG_PATH` | Ruta al `config.yml` de cloudflared (opcional si `CLOUDFLARED_DIR` ya está definida) | `/home/USUARIO/.cloudflared/config.yml` |

##### 🔑 Credenciales de administrador

El login se controla con las variables `APP_USERNAME` y `APP_PASSWORD` (esta última, un **hash bcrypt** de la contraseña, nunca la contraseña en texto plano).

**Método 1 — asistente interactivo (`npm run setup-admin-user`)**

Este comando ejecuta `node src/bin/setup-admin-user`, que abre un asistente que pregunta de forma interactiva:

- **App Username**: mínimo 4 caracteres; solo letras minúsculas (`a-z`), números (`0-9`) y guiones bajos (`_`).
- **App Password**: mínimo 8 caracteres; debe incluir al menos una mayúscula, una minúscula, un número y un símbolo (`!@#$%^&*`).
- Confirmación de seguridad.

Al confirmar, el script calcula el hash bcrypt de la contraseña y **escribe/actualiza `APP_USERNAME` y `APP_PASSWORD` directamente en el `.env`** del proyecto (usa las 10 rondas de bcrypt configuradas). Solo se guarda el hash, no la contraseña en texto plano. Después hay que **reiniciar el proceso** para que los cambios surtan efecto.

**Método 2 — manual**

1. Genera el hash bcrypt de tu contraseña:

   ```bash
   node -e "console.log(require('bcryptjs').hashSync('TU_CONTRASEÑA', 10))"
   ```

2. Pega el resultado como valor de `APP_PASSWORD` en tu `.env` (y ajusta `APP_USERNAME` si quieres):

   ```
   APP_USERNAME=admin
   APP_PASSWORD=$2a$10$....................
   ```

3. Reinicia el proceso, por ejemplo:

   ```bash
   pm2 restart <nombre-del-proceso>
   ```

**Rotar `APP_SESSION_SECRET`**

El secreto de sesión se regenera con:

```bash
openssl rand -hex 32
```

Copia el resultado en `APP_SESSION_SECRET` del `.env`. Ten en cuenta que **rotarlo invalida todas las sesiones activas**: los usuarios tendrán que volver a iniciar sesión.

> ⚠️ **Nunca** subas el `.env` real al repositorio (ni lo pegues en issues/PRs): contiene el hash de la contraseña y el secreto de sesión. Usa `env.example` como plantilla.

#### TODO
- [ ] support for relative paths
- [ ] use fs-extra for filesystem operations
- [ ] use [jsonfile](https://www.npmjs.com/package/jsonfile) for config management
- [ ] replace exec.util with [execa](https://www.npmjs.com/package/execa)
- [ ] add form based env management
- [ ] add realtime logs
- [ ] add log viewer for deployments
- [ ] add deployment abort functionality
- [ ] add deployment triggers
- [ ] add web terminal
- [ ] add zero downtime deployment strategies - blue-green, rolling etc
- [ ] add docker provider*

##### SCREENSHOTS
![PM2 Webui Login](/screenshots/login.png?raw=true "PM2 WebUI Login")
![PM2 Webui Dashboard](/screenshots/dashboard.png?raw=true "PM2 WebUI Dashboard")
![PM2 Webui App](/screenshots/app.png?raw=true "PM2 WebUI App")

##### LICENSE
MIT - Copyright (c) 2022 Surya T
