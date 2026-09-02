import m from "node:module";
console.log(typeof m.stripTypeScriptTypes, typeof m.registerHooks);
try {
  const mod = await import("./probe-ts.ts");
  console.log("direct-ts", mod.f(1));
} catch (e) {
  console.log("direct-ts failed:", e.message);
}
