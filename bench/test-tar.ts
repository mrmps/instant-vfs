import { parseTar } from "../src/tar.ts";

const TOKEN = process.env.GITHUB_TOKEN!;
const res = await fetch(
  "https://api.github.com/repos/sindresorhus/ky/tarball/HEAD",
  { headers: { Authorization: `Bearer ${TOKEN}`, "User-Agent": "test" }, redirect: "follow" },
);
if (!res.ok || !res.body) throw new Error(`bad ${res.status}`);

const unzipped = res.body.pipeThrough(new DecompressionStream("gzip"));
let n = 0, bytes = 0;
for await (const e of parseTar(unzipped)) {
  n++;
  bytes += e.bytes.byteLength;
  if (n < 5) console.log(e.path, e.size);
}
console.log(`total files: ${n}, bytes: ${bytes}`);
