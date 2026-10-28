## Ejecución del entorno WSI Viewer POC

### 1. Arquitectura actual

El visor WSI se despliega en Vercel y consume imágenes DICOM WSI almacenadas en Orthanc.

Durante las pruebas remotas, Orthanc no se expone directamente a Internet. El acceso se realiza mediante un túnel SSH, un proxy Nginx para habilitar CORS y un túnel temporal de Cloudflare.

```text
Frontend
Vercel
https://wsi-viewer-poc.vercel.app
        │
        ▼
Cloudflare Quick Tunnel
https://xxxxx.trycloudflare.com
        │
        ▼
Nginx en máquina local / WSL
localhost:8050
        │
        ▼
Túnel SSH
localhost:8044
        │
        ▼
Servidor Environ
Orthanc :8042
```

Nginx cumple dos funciones:

- Exponer solamente `/dicom-web/`.
- Agregar los headers CORS necesarios para que el frontend desplegado en Vercel pueda consumir DICOMweb.

> Esta arquitectura corresponde al entorno de desarrollo y pruebas. El Quick Tunnel de Cloudflare es temporal y cambia de URL cada vez que se vuelve a crear.

---

## 2. Requisitos

En el servidor Environ:

- Git
- Docker
- Docker Compose
- Acceso al repositorio `DICOM-FHIR`
- Acceso al repositorio `wsi-viewer-poc`

En la máquina desde la cual se expondrá Orthanc:

- SSH
- Nginx
- `cloudflared`
- WSL/Linux recomendado

---

# 3. Levantar el backend DICOM-FHIR

Conectarse al servidor Environ:

```bash
ssh bvasquez@146.155.155.98
```

Ir al repositorio:

```bash
cd /media/administrador/Storage1/bvasquez/DICOM-FHIR
```

Actualizarlo:

```bash
git pull --ff-only
```

Opcionalmente, actualizar las imágenes Docker:

```bash
docker compose pull
```

Levantar los servicios:

```bash
docker compose up -d
```

Verificar su estado:

```bash
docker compose ps
```

Los principales servicios son:

```text
Orthanc / DICOMweb   :8042
HAPI FHIR            :8080
OHIF                 :3000
```

Para comprobar Orthanc directamente en el servidor:

```bash
curl http://localhost:8042/system
```

Para comprobar DICOMweb:

```bash
curl http://localhost:8042/dicom-web/studies
```

---

# 4. Crear el túnel SSH hacia Orthanc

Este paso se realiza desde la máquina local o WSL que actuará como puente hacia el servidor.

Abrir una terminal y ejecutar:

```bash
ssh -N -L 8044:localhost:8042 \
bvasquez@146.155.155.98
```

Esto crea el siguiente enlace:

```text
localhost:8044
      │
      │ SSH
      ▼
servidor Environ localhost:8042
      │
      ▼
Orthanc
```

Esta terminal debe permanecer abierta.

Desde otra terminal se puede verificar:

```bash
curl http://localhost:8044/system
```

Si se obtiene la información JSON de Orthanc, el túnel está funcionando.

---

# 5. Levantar Nginx

La configuración utilizada por el POC se encuentra en:

```text
infra/nginx/nginx.conf
```

Actualmente Nginx escucha en:

```text
localhost:8050
```

y redirige las solicitudes hacia:

```text
localhost:8044
```

es decir:

```text
Nginx :8050
    ↓
SSH :8044
    ↓
Orthanc :8042
```

La configuración agrega los headers CORS necesarios para que Vercel pueda acceder a DICOMweb.

Para iniciar Nginx:

```bash
nginx -c ~/environ/orthanc-local/nginx/nginx.conf
```

Si Nginx ya está ejecutándose, no es necesario volver a iniciarlo.

Se puede comprobar con:

```bash
ps aux | grep nginx
```

Para verificar el proxy y CORS:

```bash
curl -i \
  -H "Origin: https://wsi-viewer-poc.vercel.app" \
  http://localhost:8050/dicom-web/studies
```

La respuesta debe incluir:

```text
HTTP/1.1 200 OK
Access-Control-Allow-Origin: *
```

Si se modifica la configuración de Nginx, recargarla con:

```bash
nginx -s reload -c ~/environ/orthanc-local/nginx/nginx.conf
```

Para detener la instancia Nginx del POC:

```bash
kill $(cat /tmp/nginx-wsi.pid)
```

> Puede existir otra instancia de Nginx del sistema ejecutándose como `root`. No debe detenerse. La instancia correspondiente a este POC se ejecuta con la configuración específica del visor y utiliza el puerto `8050`.

---

# 6. Crear el Cloudflare Quick Tunnel

Cloudflare debe apuntar a Nginx, no directamente a Orthanc ni al túnel SSH.

Ejecutar desde WSL:

```bash
cd ~/environ/orthanc-local
```

Luego:

```bash
./cloudflared tunnel \
  --protocol http2 \
  --url http://localhost:8050
```

Cloudflare generará una URL similar a:

```text
https://xxxxx.trycloudflare.com
```

El endpoint público de DICOMweb será entonces:

```text
https://xxxxx.trycloudflare.com/dicom-web
```

La terminal donde se ejecuta `cloudflared` debe permanecer abierta.

Se puede comprobar el endpoint público con:

```bash
curl -i \
  -H "Origin: https://wsi-viewer-poc.vercel.app" \
  https://xxxxx.trycloudflare.com/dicom-web/studies
```

La respuesta debe incluir:

```text
HTTP/1.1 200 OK
Access-Control-Allow-Origin: *
```

---

# 7. Configurar Vercel

En Vercel ir a:

```text
Project
→ Settings
→ Environment Variables
```

Configurar:

```text
Name:
VITE_DICOMWEB_URL
```

y como valor:

```text
https://xxxxx.trycloudflare.com/dicom-web
```

Importante: el campo de valor debe contener solamente la URL.

Correcto:

```text
https://xxxxx.trycloudflare.com/dicom-web
```

Incorrecto:

```text
VITE_DICOMWEB_URL=https://xxxxx.trycloudflare.com/dicom-web
```

Como Vite utiliza esta variable durante el build, después de modificarla es necesario generar un nuevo deployment en Vercel.

El frontend productivo queda disponible en:

```text
https://wsi-viewer-poc.vercel.app
```

---

# 8. Ejecutar el frontend en modo desarrollo

El frontend también puede ejecutarse directamente para desarrollo.

En el servidor:

```bash
cd /media/administrador/Storage1/bvasquez/wsi-viewer-poc
```

Actualizar:

```bash
git pull --ff-only
```

Instalar dependencias si corresponde:

```bash
npm install
```

Ejecutar Vite:

```bash
npm run dev
```

Actualmente el servidor de desarrollo utiliza:

```text
http://localhost:8082
```

El entorno local utiliza la variable:

```text
VITE_DICOMWEB_URL=/dicom-web
```

definida mediante `.env.local`.

El archivo `.env.local` no debe subirse al repositorio.

---

# 9. Flujo de trabajo con GitHub y Vercel

El despliegue de Vercel está conectado al repositorio de GitHub.

El flujo normal de desarrollo es:

```text
Servidor / desarrollo
        ↓
git commit
        ↓
git push
        ↓
GitHub main
        ↓
Vercel detecta el cambio
        ↓
Build
        ↓
Nuevo deployment
```

Para subir cambios:

```bash
git status
git diff
git add .
git commit -m "Descripción del cambio"
git push
```

`npm run dev` no es necesario para que Vercel funcione. Solo se utiliza para desarrollo y pruebas locales.

---

# 10. Resumen de ejecución

Cada vez que se quiera utilizar el visor remoto:

### En el servidor Environ

```bash
cd /media/administrador/Storage1/bvasquez/DICOM-FHIR

git pull --ff-only
docker compose up -d
docker compose ps
```

### En WSL — Terminal 1

Crear el túnel SSH:

```bash
ssh -N -L 8044:localhost:8042 \
bvasquez@146.155.155.98
```

### En WSL

Comprobar Nginx:

```bash
curl -i \
  -H "Origin: https://wsi-viewer-poc.vercel.app" \
  http://localhost:8050/dicom-web/studies
```

Si no está ejecutándose:

```bash
nginx -c ~/environ/orthanc-local/nginx/nginx.conf
```

### En WSL — Terminal 2

Crear el túnel público:

```bash
cd ~/environ/orthanc-local

./cloudflared tunnel \
  --protocol http2 \
  --url http://localhost:8050
```

### En Vercel

Actualizar:

```text
VITE_DICOMWEB_URL =
https://NUEVA-URL.trycloudflare.com/dicom-web
```

y generar un nuevo deployment.

Finalmente abrir:

```text
https://wsi-viewer-poc.vercel.app
```

---

# 11. Diagnóstico rápido

Si Orthanc no responde:

```bash
curl http://localhost:8042/system
```

Ejecutar en el servidor.

Si falla:

```text
Servidor / Docker / Orthanc
```

---

Si `localhost:8044` no responde:

```bash
curl http://localhost:8044/system
```

Ejecutar en WSL.

Si falla:

```text
Túnel SSH
```

---

Si `localhost:8050` no responde:

```bash
curl -i http://localhost:8050/dicom-web/studies
```

Si falla:

```text
Nginx
```

---

Si el endpoint Cloudflare no responde:

```bash
curl -i https://xxxxx.trycloudflare.com/dicom-web/studies
```

Si falla:

```text
cloudflared
```

---

Si la petición devuelve `200 OK` pero el navegador muestra:

```text
blocked by CORS policy
```

comprobar que la respuesta de Nginx contiene:

```text
Access-Control-Allow-Origin: *
```

---

Si Vercel intenta acceder a una URL antigua de Cloudflare, actualizar:

```text
VITE_DICOMWEB_URL
```

y realizar un nuevo deployment.

---

## Nota sobre producción

El mecanismo actual:

```text
Vercel
→ Cloudflare Quick Tunnel
→ WSL
→ Nginx
→ SSH
→ Orthanc
```

se utiliza para desarrollo, pruebas de streaming y benchmarks.

No corresponde todavía a una arquitectura productiva definitiva, ya que:

- depende de una máquina local;
- requiere mantener un túnel SSH activo;
- utiliza un Quick Tunnel con URL temporal;
- la URL debe actualizarse manualmente en Vercel.

Una futura implementación debería exponer DICOMweb mediante una infraestructura estable administrada por Environ, idealmente con un dominio o túnel persistente y una política CORS definida para los consumidores autorizados.