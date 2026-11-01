import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ base: process.env.GITHUB_ACTIONS ? "/7kProject/" : "/", plugins: [react()], server: { host: "0.0.0.0" } });