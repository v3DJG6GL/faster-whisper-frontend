/// <reference types="vite/client" />

// The @fontsource-variable/* packages are CSS-only side-effect imports with no
// bundled type declarations; TS 6 errors on those (TS2882) without an ambient module.
declare module "@fontsource-variable/*";
