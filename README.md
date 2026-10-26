# WSI Viewer POC

Proof of concept for interactive visualization of DICOM Whole Slide Images (WSI) using DICOMweb.

## Scope

This repository contains a custom WSI web viewer developed for the OncoMETS project.

The viewer consumes an existing Orthanc DICOMweb backend. Orthanc and OHIF are external infrastructure and are not implemented as part of this repository.

## Main technologies

- Vite
- JavaScript
- dicomweb-client
- dicom-microscopy-viewer
- OpenLayers
- DICOMweb

## Viewer flow

```text
DICOM WSI
    |
    v
Orthanc / DICOMweb
    |
    v
retrieveSeriesMetadata()
    |
    v
VLWholeSlideMicroscopyImage
    |
    v
Filter ImageType = VOLUME
    |
    v
VolumeImageViewer
    |
    v
Interactive browser rendering
```

## Main implementation

The viewer retrieves the metadata of a DICOM WSI series using its StudyInstanceUID and SeriesInstanceUID.

Only DICOM instances whose ImageType corresponds to `VOLUME` are used to construct the main multiresolution pyramid.

The viewer also inspects:

- NumberOfFrames
- TotalPixelMatrixColumns
- TotalPixelMatrixRows
- PixelSpacing
- SOPInstanceUID

Some Orthanc `BulkDataURI` values are rewritten from absolute localhost URLs to `/dicom-web` so that requests can pass through the frontend proxy.

## Local development

The frontend runs with Vite:

```bash
npm install
npm run dev
```

Default URL:

```text
http://localhost:8080
```

The development proxy maps:

```text
/dicom-web
```

to:

```text
http://localhost:8042
```

where an Orthanc DICOMweb backend is expected.

## Project structure

```text
wsi-viewer-poc/
├── public/
│   └── static/js/
├── src/
│   └── main.js
├── index.html
├── vite.config.js
├── package.json
└── package-lock.json
```

## Debugging

The viewer instance is available from the browser console as:

```javascript
window.wsiViewer
```

DevTools can be used to inspect the WSI metadata and DICOMweb frame requests.

## Validation artifacts

The repository also contains images generated during manual validation of DICOM frame retrieval and rendered image regions.

These files are debugging/validation artifacts rather than automated benchmark results.

## Current status

The POC validates:

- DICOMweb metadata retrieval
- WSI `VOLUME` instance detection
- multiresolution WSI construction
- interactive zoom and pan
- on-demand frame retrieval
- browser-side rendering