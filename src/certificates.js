import tls from "node:tls";

const configured = new WeakSet();

export function configureCertificateTrust(api = tls) {
  if (configured.has(api)) return;
  if (
    typeof api.getCACertificates !== "function" ||
    typeof api.setDefaultCACertificates !== "function"
  )
    throw new Error(
      "System certificate trust requires Node.js 22.19+ or 24.5+. Update Node.js and retry the same command; saved setup checkpoints are kept.",
    );
  // Preserve bundled, OpenSSL and NODE_EXTRA_CA_CERTS roots already selected by
  // Node. Only add roots the operating system already trusts.
  api.setDefaultCACertificates([
    ...new Set([
      ...api.getCACertificates("default"),
      ...api.getCACertificates("system"),
    ]),
  ]);
  configured.add(api);
}

export function certificateErrorMessage(error) {
  const trustErrors = new Set([
    "SELF_SIGNED_CERT_IN_CHAIN",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  ]);
  const seen = new Set();
  for (let cause = error; cause && !seen.has(cause); cause = cause.cause) {
    seen.add(cause);
    if (trustErrors.has(cause.code))
      return "The HTTPS certificate is not trusted by this computer. BoxCI uses Node's existing and system certificate stores. Ask your network administrator to install the required trusted CA, then retry the same command; saved setup checkpoints are kept.";
  }
  return error.message;
}
