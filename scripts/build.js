// Build dist/NetworkTracer.exe bằng @yao-pkg/pkg rồi gắn icon + version info bằng resedit.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist', 'NetworkTracer.exe');
const ico = path.join(root, 'assets', 'icon.ico');
const pkgJson = require(path.join(root, 'package.json'));

if (!fs.existsSync(ico)) execSync('node scripts/make-icon.js', { cwd: root, stdio: 'inherit' });

// --no-bytecode: Playwright dùng dynamic import(), không chạy được khi biên dịch sang bytecode
execSync(`npx pkg . --targets node18-win-x64 --no-bytecode --public-packages "*" --public --compress GZip --output "${out}"`, { cwd: root, stdio: 'inherit' });

(async () => {
  const ResEdit = await import('resedit');
  const { NtExecutable, NtExecutableResource, Resource, Data } = ResEdit.default || ResEdit;
  const exe = NtExecutable.from(fs.readFileSync(out), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);

  const iconFile = Data.IconFile.from(fs.readFileSync(ico));
  Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, iconFile.icons.map((i) => i.data));

  const vi = Resource.VersionInfo.fromEntries(res.entries)[0] || Resource.VersionInfo.createEmpty();
  const [a, b, c] = pkgJson.version.split('.').map(Number);
  vi.setFileVersion(a, b, c, 0, 1033);
  vi.setProductVersion(a, b, c, 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    ProductName: 'Network Tracer',
    FileDescription: 'Network Tracer',
    OriginalFilename: 'NetworkTracer.exe',
    InternalName: 'NetworkTracer',
    LegalCopyright: '',
    CompanyName: '',
  });
  vi.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  fs.writeFileSync(out, Buffer.from(exe.generate()));
  console.log(`Built ${out}`);
})();
