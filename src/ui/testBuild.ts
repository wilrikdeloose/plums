/** Compile-time flag from scripts/desktop.mjs (`--testmode=true`); always false in web and normal builds. */
export const TEST_BUILD = import.meta.env.VITE_PLUMS_TESTMODE === "true";
