# Quick Start

## 1. Requirements

You need:

- Node.js
- npm
- access to a DICOMweb backend
- a DICOM WSI study and series

The current development configuration expects the backend at:

```text
http://localhost:8042
```

## 2. Install dependencies

```bash
npm install
```

## 3. Configure the WSI

The current POC defines the following values in `src/main.js`:

```javascript
const studyInstanceUID = "...";
const seriesInstanceUID = "...";
```

Set them to the DICOM WSI study and series that you want to visualize.

## 4. Start the viewer

```bash
npm run dev
```

The viewer should become available at:

```text
http://localhost:8080
```

## 5. Backend routing

During development, requests to:

```text
/dicom-web
```

are proxied by Vite to:

```text
http://localhost:8042
```

This behavior is configured in `vite.config.js`.

## 6. Validate the connection

From the machine running the backend:

```bash
curl http://localhost:8042/system
```

and:

```bash
curl   -H "Accept: application/dicom+json"   http://localhost:8042/dicom-web/studies
```

## 7. Browser inspection

Open DevTools.

### Console

The viewer logs:

- metadata retrieval
- WSI `VOLUME` levels
- Number of Frames
- Total Pixel Matrix dimensions
- Pixel Spacing
- viewer initialization

The viewer object is also available as:

```javascript
window.wsiViewer
```

### Network

Filter requests by:

```text
dicom-web
```

Then use zoom and pan to inspect the requests generated while navigating the WSI.

## 8. Expected flow

```text
metadata
   ↓
WSI instances
   ↓
VOLUME levels
   ↓
VolumeImageViewer
   ↓
frame retrieval
   ↓
interactive render
```

## Notes

Orthanc and OHIF are not part of this repository.

This repository contains only the custom WSI viewer POC and related validation artifacts.
