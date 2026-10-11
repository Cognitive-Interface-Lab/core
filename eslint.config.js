import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["packages/**"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...["window", "document", "localStorage", "sessionStorage"].map((name) => ({
          name,
          message: "No browser globals in packages; use an injected interface instead.",
        })),
      ],
    },
  },
);
