import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["@abaplint/core", "jszip", "pdfmake"],
  // The app sits inside the ABAPGIT_ALV repo; pin the root so a stray lockfile there is never picked up.
  outputFileTracingRoot: fileURLToPath(new URL(".", import.meta.url)),
};
export default nextConfig;
