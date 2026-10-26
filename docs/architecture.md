# Architecture

## Overview

The WSI Viewer POC is a browser client that consumes Whole Slide Images stored as DICOM WSI through a DICOMweb-compatible backend.

```text
                     External infrastructure
                 ┌─────────────────────────────┐
                 │                             │
                 │        DICOM WSI            │
                 │            │                │
                 │            ▼                │
                 │         Orthanc             │
                 │     DICOMweb backend        │
                 │                             │
                 └────────────┬────────────────┘
                              │
                         DICOMweb HTTP
                              │
                              ▼
                 ┌─────────────────────────────┐
                 │        WSI Viewer POC       │
                 │                             │
                 │   dicomweb-client           │
                 │          │                  │
                 │          ▼                  │
                 │   series metadata           │
                 │          │                  │
                 │          ▼                  │
                 │ VLWholeSlideMicroscopyImage │
                 │          │                  │
                 │          ▼                  │
                 │      VOLUME levels          │
                 │          │                  │
                 │          ▼                  │
                 │    VolumeImageViewer        │
                 │          │                  │
                 │          ▼                  │
                 │ Browser viewport / OpenLayers│
                 └─────────────────────────────┘
```

## Responsibilities

### DICOMweb backend

External to this repository.

Responsibilities:

- stores DICOM WSI instances
- exposes series metadata
- exposes DICOM frames / bulk data
- serves DICOMweb requests

### WSI Viewer POC

Implemented in this repository.

Responsibilities:

- connect to the DICOMweb endpoint
- retrieve series metadata
- interpret VL Whole Slide Microscopy instances
- identify WSI `VOLUME` levels
- construct the multiresolution viewer
- request required data as the viewport changes
- render the slide interactively in the browser

## Request flow

```text
Browser starts viewer
        │
        ▼
retrieveSeriesMetadata()
        │
        ▼
DICOMweb metadata response
        │
        ▼
Parse WSI instances
        │
        ▼
Filter ImageType = VOLUME
        │
        ▼
Create VolumeImageViewer
        │
        ▼
Render viewport
        │
        ├── zoom
        ├── pan
        └── viewport changes
               │
               ▼
        required frame data
               │
               ▼
          DICOMweb requests
```

## Development proxy

During local development:

```text
Browser
  │
  │ /dicom-web/...
  ▼
Vite :8080
  │
  │ proxy
  ▼
DICOMweb backend :8042
```

The proxy is configured in `vite.config.js`.

## BulkDataURI rewriting

Some DICOM metadata can contain absolute `BulkDataURI` values pointing directly to the backend host.

The viewer normalizes those URLs to `/dicom-web/...` so that browser requests continue through the frontend proxy.

## Rendering

The viewer does not treat the WSI as one conventional raster image.

Instead, it works with the DICOM WSI multiresolution representation and uses the available `VOLUME` instances to construct the image pyramid used by `VolumeImageViewer`.

The browser then retrieves and renders the required image data according to the current viewport.

## External components

These components may be present in the development environment but are outside the scope of this repository:

- Orthanc
- OHIF
- WSI-to-DICOM conversion tooling
- OncoMETS clinical application
