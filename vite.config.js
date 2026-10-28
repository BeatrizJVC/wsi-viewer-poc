import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 8082,
    proxy: {
      "/fhir": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
      "/dicom-web": {
        target: "http://localhost:8042",
        changeOrigin: true,
      },
    },
  },
});
