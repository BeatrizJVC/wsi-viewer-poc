# Remote Deployment: Vercel + Cloudflare

## Overview

The WSI Viewer POC was initially executed locally using Vite and a local DICOMweb backend.

A later stage of the project moved the frontend to Vercel in order to evaluate the viewer through a remotely accessible architecture.

The frontend is deployed independently from the DICOMweb backend.

## Architecture

```text
Browser
   │
   ▼
Vercel frontend
   │
   │ VITE_DICOMWEB_URL
   ▼
Cloudflare Tunnel
   │
   ▼
DICOMweb backend
   │
   ▼
Orthanc
   │
   ├── metadata
   └── WSI frames
          │
          ▼
   browser rendering
```

## Frontend deployment

The frontend was deployed as the Vercel project:

```text
wsi-viewer-poc
```

The deployed viewer is available at:

```text
https://wsi-viewer-poc.vercel.app
```

The backend URL is not hard-coded into the frontend source.

Instead, the application reads:

```javascript
const dicomWebUrl = import.meta.env.VITE_DICOMWEB_URL;
```

and initializes the DICOMweb client with:

```javascript
const client = new DICOMwebClient.api.DICOMwebClient({
  url: dicomWebUrl,
});
```

## Environment variable

The deployment requires:

```text
VITE_DICOMWEB_URL
```

Example:

```env
VITE_DICOMWEB_URL=https://your-public-dicomweb-endpoint.example.com/dicom-web
```

The real endpoint should be configured in the deployment environment and should not be committed to the repository.

## Cloudflare role

Cloudflare is not the DICOM backend.

It is used to expose the existing DICOMweb service through a public HTTPS endpoint.

Therefore:

```text
Vercel
   │
   ▼
Cloudflare public endpoint
   │
   ▼
DICOMweb / Orthanc
```

The Orthanc instance remains part of the external infrastructure.

## Difference from local development

### Local POC

The initial version used:

```text
Browser
   │
   ▼
Vite :8080
   │
   │ development proxy
   ▼
Orthanc :8042
```

In that version, requests to:

```text
/dicom-web
```

were proxied locally to Orthanc.

### Remote POC

The remote version uses:

```text
Browser
   │
   ▼
Vercel frontend
   │
   │ VITE_DICOMWEB_URL
   ▼
Cloudflare
   │
   ▼
DICOMweb / Orthanc
```

The frontend can therefore be accessed independently of the machine hosting the DICOM backend.

## BulkDataURI handling

During development, some Orthanc metadata contained absolute `BulkDataURI` references such as:

```text
http://localhost:8042/dicom-web/...
```

The viewer includes a mechanism to rewrite these references so the browser does not attempt to access its own localhost.

This logic originated in the local development architecture and should be reviewed when defining a permanent production deployment.

## Scope

This repository implements:

- the WSI frontend;
- DICOMweb integration;
- WSI metadata processing;
- `VOLUME` pyramid construction;
- interactive rendering;
- benchmark tooling.

External components include:

- Orthanc;
- Cloudflare Tunnel;
- OHIF;
- WSI-to-DICOM conversion tooling;
- the OncoMETS clinical platform.
