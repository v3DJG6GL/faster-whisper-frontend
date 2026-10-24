/// <reference types="vite/client" />

// The @fontsource-variable/* and @fontsource/* packages are CSS-only side-effect imports
// with no bundled type declarations; TypeScript errors on those (TS2882) without an ambient module.
declare module "@fontsource-variable/*";
declare module "@fontsource/*";
