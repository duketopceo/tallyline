// ESLint flat config used only by `pnpm lint:design`.
import tseslint from "typescript-eslint";
import silverLining from "./index.mjs";

export default [
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { "silver-lining": silverLining },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: {
      "silver-lining/no-raw-color": "error",
      "silver-lining/no-offscale-font": "error",
      "silver-lining/no-palette-color": "error",
    },
  },
];
