// The local certificate authority for LAN access (research 04, section 4.2). A phone trusts
// this root once. The root is name-constrained to .local, localhost and private addresses,
// so even a stolen key cannot intercept anything on the public web. Leaf certificates meet
// Apple's rules: SAN, serverAuth, SHA-2, ECDSA and at most 825 days.

import { execFile } from 'node:child_process';
import { X509Certificate, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const ROOT_DAYS = 3650;
const LEAF_DAYS = 397;
const RENEW_BEFORE_MS = 30 * 24 * 3600 * 1000;
const NAME = 'Venezia Local Root';

const ROOT_CONFIG = `[req]
distinguished_name = dn
[dn]
[root]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical, permitted;DNS:local, permitted;DNS:localhost, permitted;IP:127.0.0.0/255.0.0.0, permitted;IP:10.0.0.0/255.0.0.0, permitted;IP:172.16.0.0/255.240.0.0, permitted;IP:192.168.0.0/255.255.0.0, permitted;IP:169.254.0.0/255.255.0.0
`;

function leafConfig(hosts, ips) {
  const names = [...hosts.map((host) => `DNS:${host}`), ...ips.map((ip) => `IP:${ip}`)].join(', ');
  return `[leaf]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
subjectAltName = ${names}
`;
}

function coversNames(cert, hosts, ips) {
  return hosts.every((host) => cert.checkHost(host) !== undefined) && ips.every((ip) => cert.checkIP(ip) !== undefined);
}

/** The SHA-256 fingerprint of a certificate, as shown to a person comparing it by eye. */
export function fingerprint(pem) {
  return new X509Certificate(pem).fingerprint256;
}

/**
 * Make sure a root and a leaf exist for these names, issuing whatever is missing, expiring
 * or wrong. Safe to call again when the machine's address changes.
 * @param {{dir: string, hosts: string[], ips: string[], opensslBin?: string, now?: () => number}} options
 * @returns {Promise<{key: string, cert: string, ca: string, caPath: string, fingerprint: string, issued: boolean}>}
 */
export async function ensureCertificates({ dir, hosts, ips, opensslBin = 'openssl', now = Date.now }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = (name) => path.join(dir, name);
  const openssl = (args) => run(opensslBin, args, { cwd: dir, timeout: 20_000 });

  const makeKey = async (name) => {
    await openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', file(name)]);
    fs.chmodSync(file(name), 0o600);
  };

  const rootExpired = () => {
    if (!fs.existsSync(file('ca.crt')) || !fs.existsSync(file('ca.key'))) return true;
    return Date.parse(new X509Certificate(fs.readFileSync(file('ca.crt'))).validTo) - now() < RENEW_BEFORE_MS;
  };

  let rootIssued = false;
  if (rootExpired()) {
    await makeKey('ca.key');
    fs.writeFileSync(file('ca.cnf'), ROOT_CONFIG);
    await openssl([
      'req', '-new', '-x509', '-sha256', '-days', String(ROOT_DAYS), '-key', file('ca.key'), '-config', file('ca.cnf'),
      '-extensions', 'root', '-subj', `/O=Venezia/CN=${NAME}`, '-out', file('ca.crt'),
    ]);
    rootIssued = true;
  }

  const leafGood = () => {
    if (rootIssued || !fs.existsSync(file('leaf.crt')) || !fs.existsSync(file('leaf.key'))) return false;
    const leaf = new X509Certificate(fs.readFileSync(file('leaf.crt')));
    const root = new X509Certificate(fs.readFileSync(file('ca.crt')));
    return leaf.verify(root.publicKey)
      && Date.parse(leaf.validTo) - now() > RENEW_BEFORE_MS
      && coversNames(leaf, hosts, ips);
  };

  let issued = rootIssued;
  if (!leafGood()) {
    await makeKey('leaf.key');
    fs.writeFileSync(file('leaf.cnf'), leafConfig(hosts, ips));
    await openssl([
      'req', '-new', '-sha256', '-key', file('leaf.key'), '-subj', `/O=Venezia/CN=${hosts[0]}`, '-out', file('leaf.csr'),
      '-config', file('ca.cnf'),
    ]);
    await openssl([
      'x509', '-req', '-sha256', '-days', String(LEAF_DAYS), '-in', file('leaf.csr'), '-CA', file('ca.crt'), '-CAkey', file('ca.key'),
      '-set_serial', `0x${randomBytes(16).toString('hex').replace(/^./, '4')}`, '-extfile', file('leaf.cnf'), '-extensions', 'leaf',
      '-out', file('leaf.crt'),
    ]);
    fs.rmSync(file('leaf.csr'), { force: true });
    issued = true;
  }

  const ca = fs.readFileSync(file('ca.crt'), 'utf8');
  return {
    key: fs.readFileSync(file('leaf.key'), 'utf8'),
    cert: fs.readFileSync(file('leaf.crt'), 'utf8'),
    ca,
    caPath: file('ca.crt'),
    fingerprint: fingerprint(ca),
    issued,
  };
}

/**
 * An iOS configuration profile that installs the root. After installing, the phone still
 * needs full trust turned on in Settings, General, About, Certificate Trust Settings.
 * @param {string} caPem
 */
export function mobileConfig(caPem) {
  const der = new X509Certificate(caPem).raw.toString('base64');
  const stable = (label) => {
    const hex = createHash('sha256').update(label).update(caPem).digest('hex').toUpperCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-A${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key><string>venezia-root.cer</string>
      <key>PayloadContent</key><data>${der}</data>
      <key>PayloadDescription</key><string>Lets this phone trust your own Venezia server.</string>
      <key>PayloadDisplayName</key><string>${NAME}</string>
      <key>PayloadIdentifier</key><string>local.venezia.root.${stable('payload-id').slice(0, 8)}</string>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadUUID</key><string>${stable('payload')}</string>
      <key>PayloadVersion</key><integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key><string>Installs the certificate for your own Venezia server. It can only vouch for .local names and private addresses.</string>
  <key>PayloadDisplayName</key><string>Venezia</string>
  <key>PayloadIdentifier</key><string>local.venezia.profile.${stable('profile-id').slice(0, 8)}</string>
  <key>PayloadOrganization</key><string>Venezia</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${stable('profile')}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>
`;
}
