## Quick Start

This project uses a Vercel-hosted frontend connected to an Orthanc DICOMweb backend running on the Environ server.

For remote testing, the current development architecture is:

```text
Vercel
  ↓
Cloudflare Quick Tunnel
  ↓
Nginx on WSL (:8050)
  ↓
SSH tunnel (:8044)
  ↓
Orthanc on Environ server (:8042)
```

> This setup is intended for development, streaming tests, and benchmarks. It is not the final production architecture.

### 1. Start the DICOM-FHIR backend

On the Environ server:

```bash
cd /media/administrador/Storage1/bvasquez/DICOM-FHIR

git pull --ff-only
docker compose pull
docker compose up -d
docker compose ps
```

Main services:

```text
Orthanc / DICOMweb   :8042
HAPI FHIR            :8080
OHIF                 :3000
```

Verify Orthanc:

```bash
curl http://localhost:8042/system
```

---

### 2. Create the SSH tunnel

From WSL/local machine:

```bash
ssh -N -L 8044:localhost:8042 \
bvasquez@146.155.155.98
```

Keep this terminal open.

Verify the tunnel from another WSL terminal:

```bash
curl http://localhost:8044/system
```

---

### 3. Start or verify Nginx

Nginx listens on:

```text
localhost:8050
```

and proxies requests to:

```text
localhost:8044
```

The configuration used by this project is available at:

```text
infra/nginx/nginx.conf
```

Start Nginx if it is not already running:

```bash
nginx -c ~/environ/orthanc-local/nginx/nginx.conf
```

If Nginx is already running, do not start another instance.

Check it with:

```bash
ps aux | grep nginx
```

Verify DICOMweb and CORS:

```bash
curl -i \
  -H "Origin: https://wsi-viewer-poc.vercel.app" \
  http://localhost:8050/dicom-web/studies
```

The response should contain:

```text
HTTP/1.1 200 OK
Access-Control-Allow-Origin: *
```

If the Nginx configuration was modified:

```bash
nginx -s reload \
  -c ~/environ/orthanc-local/nginx/nginx.conf
```

---

### 4. Start the Cloudflare Quick Tunnel

From WSL:

```bash
cd ~/environ/orthanc-local

./cloudflared tunnel \
  --protocol http2 \
  --url http://localhost:8050
```

Keep this terminal open.

Cloudflare will provide a temporary URL similar to:

```text
https://xxxxx.trycloudflare.com
```

The public DICOMweb endpoint will therefore be:

```text
https://xxxxx.trycloudflare.com/dicom-web
```

---

### 5. Update Vercel

Go to:

```text
Vercel
→ Project
→ Settings
→ Environment Variables
```

Update:

```text
Name:
VITE_DICOMWEB_URL
```

with:

```text
https://xxxxx.trycloudflare.com/dicom-web
```

Only the URL must be entered as the value.

Correct:

```text
https://xxxxx.trycloudflare.com/dicom-web
```

Incorrect:

```text
VITE_DICOMWEB_URL=https://xxxxx.trycloudflare.com/dicom-web
```

Because Vite reads environment variables at build time, create a new Vercel deployment after changing this value.

The deployed viewer is available at:

```text
https://wsi-viewer-poc.vercel.app
```

---

### Local frontend development

Running the frontend locally is independent from Vercel.

On the Environ server:

```bash
cd /media/administrador/Storage1/bvasquez/wsi-viewer-poc

git pull --ff-only
npm install
npm run dev
```

The development server currently runs on:

```text
http://localhost:8082
```

The local environment uses:

```text
VITE_DICOMWEB_URL=/dicom-web
```

through `.env.local`.

Do not commit `.env.local`.

---

### Quick troubleshooting

Check each layer in order.

Orthanc on server:

```bash
curl http://localhost:8042/system
```

SSH tunnel from WSL:

```bash
curl http://localhost:8044/system
```

Nginx and CORS:

```bash
curl -i http://localhost:8050/dicom-web/studies
```

Cloudflare:

```bash
curl -i https://xxxxx.trycloudflare.com/dicom-web/studies
```

If all of these work but the Vercel viewer does not, verify that `VITE_DICOMWEB_URL` contains the current Cloudflare Quick Tunnel URL and redeploy the frontend.

### Development note

The current remote-testing path is:

```text
Vercel
→ Cloudflare Quick Tunnel
→ Nginx
→ SSH tunnel
→ Orthanc
```

Since the Cloudflare Quick Tunnel URL changes when restarted, the Vercel environment variable must currently be updated manually.

A future production architecture should replace this with a stable backend endpoint managed by Environ.

For the full setup guide in Spanish, see:
[Remote WSI Viewer Setup (ES)](docs/deployment-guide-es.md)

# WSI Viewer POC

Proof of concept for interactive visualization of DICOM Whole Slide Images (WSI) using DICOMweb.

## What this repository contains

This repository contains the custom WSI web viewer developed for the OncoMETS project.

The main contribution of this POC is the browser-side visualization flow:

```text
DICOM WSI
   ↓
DICOMweb backend
   ↓
dicomweb-client
   ↓
DICOM WSI metadata parsing
   ↓
VOLUME pyramid selection
   ↓
dicom-microscopy-viewer
   ↓
interactive browser rendering
```

Orthanc and OHIF are external infrastructure used during development and validation. They are not implemented as part of this repository.

## Main technologies

- JavaScript
- Vite
- `dicomweb-client`
- `dicom-microscopy-viewer`
- OpenLayers
- DICOMweb

## Main viewer flow

The viewer performs the following steps:

1. Creates a DICOMweb client.
2. Retrieves series metadata using `StudyInstanceUID` and `SeriesInstanceUID`.
3. Parses each instance as a `VLWholeSlideMicroscopyImage`.
4. Keeps only instances whose `ImageType` corresponds to `VOLUME`.
5. Rewrites absolute `BulkDataURI` values when necessary so requests pass through the frontend proxy.
6. Creates a `VolumeImageViewer`.
7. Renders the WSI into the browser viewport.
8. Retrieves image frames as required while navigating with zoom and pan.

## Key implementation

### DICOMweb client

```javascript
const client = new DICOMwebClient.api.DICOMwebClient({
  url: "/dicom-web",
});
```

### Retrieve metadata

```javascript
const metadata = await client.retrieveSeriesMetadata({
  studyInstanceUID,
  seriesInstanceUID,
});
```

### Keep only WSI volume instances

```javascript
if (imageFlavor === "VOLUME") {
  volumeImages.push(image);
}
```

### Create and render the viewer

```javascript
const viewer =
  new DICOMMicroscopyViewer.viewer.VolumeImageViewer({
    client,
    metadata: volumeImages,
  });

viewer.render({
  container: "viewport",
});
```

## WSI pyramid inspection

During initialization, the viewer extracts and logs information such as:

- SOP Instance UID
- Number of Frames
- Total Pixel Matrix Columns
- Total Pixel Matrix Rows
- Pixel Spacing

This information is useful for validating the multiresolution DICOM WSI structure.

## BulkDataURI handling

Some metadata returned by Orthanc can contain absolute references such as:

```text
http://localhost:8042/dicom-web/...
```

The viewer rewrites those references to:

```text
/dicom-web/...
```

so they are routed through the same frontend proxy.

## Local development

Requirements:

- Node.js
- npm
- a DICOMweb-compatible backend
- a DICOM WSI series

Install dependencies:

```bash
npm install
```

Run the development server:

```bash
npm run dev
```

The viewer runs by default at:

```text
http://localhost:8080
```

The Vite development proxy maps:

```text
/dicom-web
```

to:

```text
http://localhost:8042
```

where the DICOMweb backend is expected.

## Project structure

```text
wsi-viewer-poc/
├── public/
│   └── static/js/
│       ├── dataLoader.worker.min.js
│       ├── dicomiccwasm.wasm
│       └── libjpegturbowasm_decode.wasm
├── src/
│   └── main.js
├── docs/
│   ├── architecture.md
│   └── quickstart.md
├── index.html
├── vite.config.js
├── package.json
├── package-lock.json
└── README.md
```

## Browser debugging

The viewer instance is exposed as:

```javascript
window.wsiViewer
```

Useful tools:

```text
DevTools
├── Console
│   └── WSI pyramid metadata and initialization logs
└── Network
    └── DICOMweb metadata and frame requests
```

## Validation artifacts

The repository also contains images generated during manual validation of DICOM frame retrieval and image-region rendering.

These files are debugging and validation artifacts, not automated benchmark results.

## Current status

The POC validates:

- DICOMweb metadata retrieval
- WSI `VOLUME` instance detection
- multiresolution WSI construction
- interactive zoom and pan
- on-demand frame retrieval
- browser-side rendering
- inspection of WSI pyramid metadata
- remote frontend deployment experiments

## Scope

This repository focuses specifically on the WSI viewer.

External components used by the POC include:

- Orthanc as DICOM/DICOMweb backend
- DICOM WSI conversion pipeline
- OHIF as an external reference viewer
- OncoMETS clinical application

Those components are not implemented in this repository.

For a concise architecture description, see [`docs/architecture.md`](docs/architecture.md).

For setup instructions, see [`docs/quickstart.md`](docs/quickstart.md).


## Documentation

Additional technical documentation:

- [Architecture](docs/architecture.md)
- [Quick start](docs/quickstart.md)
- [Remote deployment with Vercel and Cloudflare](docs/deployment-vercel.md)
- [WSI streaming benchmarks](docs/benchmarks.md)