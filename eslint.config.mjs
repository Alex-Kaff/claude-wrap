// Flat ESLint config (ESLint 9). TypeScript-aware linting for src/, plain
// JS linting for the .mjs test files, with Prettier owning all formatting.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },

  // TypeScript sources.
  {
    files: ["src/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      // `any` is occasionally pragmatic (e.g. typed-emitter fan-out); surface
      // it as a warning rather than blocking CI.
      "@typescript-eslint/no-explicit-any": "warn",
      // Allow intentionally-unused args/vars prefixed with underscore.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // Plain-JS test files (node:test, .mjs).
  {
    files: ["test/**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { process: "readonly", setTimeout: "readonly", Buffer: "readonly" },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },

  // Prettier last — disables stylistic rules that would fight the formatter.
  prettier,
);
