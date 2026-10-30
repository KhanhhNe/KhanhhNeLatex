import { bindings, defineConfig } from "cf/config";

export default defineConfig({
	worker: {
		name: "khanhhne-latex",
		compatibilityDate: "2026-10-19",
		compatibilityFlags: [
			"nodejs_compat",
		],
		entrypoint: "server/worker.js",
		assets: {
			notFoundHandling: "single-page-application",
			runWorkerFirst: [
				"/api/*",
			],
		},
		env: {
			APP_ORIGIN: bindings.text(process.env.APP_ORIGIN || "local-auto"),
			DB: bindings.d1({
				name: "khanhhne-latex",
				id: "cd41987e-fef8-4d16-990c-fb4c0813786e",
			}),
			ASSETS: bindings.assets(),
		},
	},
});
