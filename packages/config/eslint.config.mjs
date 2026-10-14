import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/.next-e2e/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/next-env.d.ts",
      "**/*.cjs",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" },
      ],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
);
