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
