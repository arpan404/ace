// SPDX-License-Identifier: Apache-2.0
//! TLS fixtures, generated once with OpenSSL 3.0.16 for the tests below (T1b.1a).
//! They are test data, never an identity any listener serves: the daemon loads
//! its own from `tls/key.pem` and `tls/cert.pem` and Rust never generates one.

/// An RSA-2048 self-signed certificate, CN=ace rsa (openssl req -x509 -newkey rsa:2048 -nodes).
pub(crate) const RSA_CERT: &str = "\
-----BEGIN CERTIFICATE-----\n\
MIIDBTCCAe2gAwIBAgIUKYUGLsX5lMPO329Qd3hOIw8OHfEwDQYJKoZIhvcNAQEL\n\
BQAwEjEQMA4GA1UEAwwHYWNlIHJzYTAeFw0yNjExMjQxMjE3MzRaFw0zNjExMjEx\n\
MjE3MzRaMBIxEDAOBgNVBAMMB2FjZSByc2EwggEiMA0GCSqGSIb3DQEBAQUAA4IB\n\
DwAwggEKAoIBAQDGQNWls1eLrjtxc90etZqAFm9csRl5oLF3NtL3Wa82LV/ifGnG\n\
K3iEA6aixpC1wav1YV/XasrpS5qw6iyk1tFOKUqJ7Z58gj8ARCEGrS52hejwZtA6\n\
jHHiA2bRcy41/KWrvmFJSw+gbnvmyNdnLz/O18+6nkbfbf0j6uP3Vy2zn0LG5FK5\n\
f5/mZmKM9RRVdh863L9Yb9D/XUna2ySpWSSLXSiNCBKn54952w44mAzBx16w0i5q\n\
cOr7i7jgO95y7friHPw2F6WY0bAUu3lK2anfBgyzTR7eB2iLysox/bGa1YMeNiTa\n\
DyZID+TQi+wxO4DdNhyIzVd/U3K7J10Jh2UHAgMBAAGjUzBRMB0GA1UdDgQWBBTT\n\
ynjo+TRWuj05v+Tyx5pcLssFcjAfBgNVHSMEGDAWgBTTynjo+TRWuj05v+Tyx5pc\n\
LssFcjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAcxsObABAW\n\
JXXnf97TGyBOzoG27F7/uPA1WkxaptgrIo38Y7TRdK6gIpb9PfynGDmigcgIf4V8\n\
BTj3z46mLRn91Bh638q1h1//PjbKv75hcVpH/VWseqVvfCdlzmZvwaPGZ9I4qWaa\n\
fR/CJRy8N6yga51qPUMAjQ+UTII3szNkHD2+ko3GyPobbHFNXs+KogVxU8gWnCWS\n\
byk/fomAEhxNkSY5ELxKHcYfbDNn+DhOTajxm9pImRCppIj0qKRBRGIaIbq1wSM6\n\
sy/imYKsVxwSwMwQ9C1+FYSSVat/7BH4T4pnJbG6jlBOcpP9E0Mb+TLBC70B9muf\n\
G/LM4SzxDZZz\n\
-----END CERTIFICATE-----\n";

/// The same key, PKCS#8 (`BEGIN PRIVATE KEY`), as OpenSSL 3 and `node-tls-identity.ts` write it.
pub(crate) const RSA_KEY_PKCS8: &str = "\
-----BEGIN PRIVATE KEY-----\n\
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDGQNWls1eLrjtx\n\
c90etZqAFm9csRl5oLF3NtL3Wa82LV/ifGnGK3iEA6aixpC1wav1YV/XasrpS5qw\n\
6iyk1tFOKUqJ7Z58gj8ARCEGrS52hejwZtA6jHHiA2bRcy41/KWrvmFJSw+gbnvm\n\
yNdnLz/O18+6nkbfbf0j6uP3Vy2zn0LG5FK5f5/mZmKM9RRVdh863L9Yb9D/XUna\n\
2ySpWSSLXSiNCBKn54952w44mAzBx16w0i5qcOr7i7jgO95y7friHPw2F6WY0bAU\n\
u3lK2anfBgyzTR7eB2iLysox/bGa1YMeNiTaDyZID+TQi+wxO4DdNhyIzVd/U3K7\n\
J10Jh2UHAgMBAAECggEASUZEUNqg1F0g1lVzGDsZ8BaasWE5n7Uvcnb+cXKh6j3K\n\
Dz1ZoOeHQw/QYqBOcwcyhd6oHEf52FFbyuC6gHBvatqjFKiRJ8bB/1iu9jdDEYZ7\n\
6oKtmr43B0ink2llXonTN8+FSKAoFe1P+SQpTRdvF4W3XuvKGSGfasuR12TO3PCs\n\
RagLgcmOA71uOorYXd2SoLayPXC+G0sqWNYlkDOf6vPHhIjV8ko6QQ/sWx88WfKK\n\
pyveFQD7C3ErdbVviQfE9TvnurrKHrCRMllsJ79Ncfm05Tjb1jgaf9o7R68BvJ5R\n\
I7sn1KJ+J9G0ncVPT72K69tZXmF7LbT/eX0XHCjWyQKBgQD5qSZ0KV3Pkgdh/PEg\n\
Y42ZxtZnB9nqYIV8pdVS4rfbSM+tb8M0i4xY/04BvD3h9soDBsay+0gie8QzXhS7\n\
HcbVjLj5dDChPLNTdPlHj5YrfWNw4CzcsOQD1q2L1FgYhMi13vypFFnKtRK6HKFc\n\
jEmhmvMwKb9QOpmxLKPB+a2ZHwKBgQDLSYY+oldeDs2lZxOsvyyH5vH8Ih1/Iat8\n\
UHrxUzUZOtHQJYu8dBXKu7HJUOSPIU4mOgmmrsF2lQJ1dg2HCxLiwuj93No0Pyyd\n\
aTZayf8xBrdqHZsr9HAZPgNlgKcRYKoTsSmVDggk+nPalPNmpH9Hh9JX4lXXjIGa\n\
TKjwRPFvGQKBgF4hvtPxfON0hcAWZLv3jT470D8MoMdUGUCELkiQHw5ZB6S3DPzU\n\
2Nf9euYAmbyHFmfJuEVnpS0LSVCs2lgqw/tkkaHMg0Fn551B73Nh2hcPsdyvSXr0\n\
XyRrXwfnykeEWUDpkI4XlDtvxl3Rya1hX6nFCIhSVUXksmoxEJVklGW1AoGBAMGY\n\
0rUhi8yyklwb7xvLsI/4e6mfn7GsEhFA3+SlVmMhpiDxMMOXVg2NdIIBfLlmgXNc\n\
QEayFOJmhEHy3G0oOaMk9hiV1GR/aXC7ex05U8OP3uq7KUTR9FPFwBxRSkn9YduB\n\
E9W02ELHFcArrCWrMN+hVMuHbDLrx513tkejkL45AoGAY36hkNqCYnVBP0FZgOY2\n\
Hg3xTNsTJhppchTPTOzT+N5FtmoGE6wrRg0fYoozq1KeE5crhNxz/VKHnRgBRDdj\n\
aSvPuN9Un/ypwzDDfgCFE0KE9ELfJ0wkbVeM7zcdgUphb9wX+W63OlDsSJdpcZgS\n\
id+oqA4zkoAEC8WrXoZIqYk=\n\
-----END PRIVATE KEY-----\n";

/// The same key, PKCS#1 (`BEGIN RSA PRIVATE KEY`, `openssl rsa -traditional`): LibreSSL's output.
pub(crate) const RSA_KEY_PKCS1: &str = "\
-----BEGIN RSA PRIVATE KEY-----\n\
MIIEowIBAAKCAQEAxkDVpbNXi647cXPdHrWagBZvXLEZeaCxdzbS91mvNi1f4nxp\n\
xit4hAOmosaQtcGr9WFf12rK6UuasOospNbRTilKie2efII/AEQhBq0udoXo8GbQ\n\
Ooxx4gNm0XMuNfylq75hSUsPoG575sjXZy8/ztfPup5G3239I+rj91cts59CxuRS\n\
uX+f5mZijPUUVXYfOty/WG/Q/11J2tskqVkki10ojQgSp+ePedsOOJgMwcdesNIu\n\
anDq+4u44Dvecu364hz8NhelmNGwFLt5Stmp3wYMs00e3gdoi8rKMf2xmtWDHjYk\n\
2g8mSA/k0IvsMTuA3TYciM1Xf1NyuyddCYdlBwIDAQABAoIBAElGRFDaoNRdINZV\n\
cxg7GfAWmrFhOZ+1L3J2/nFyoeo9yg89WaDnh0MP0GKgTnMHMoXeqBxH+dhRW8rg\n\
uoBwb2raoxSokSfGwf9YrvY3QxGGe+qCrZq+NwdIp5NpZV6J0zfPhUigKBXtT/kk\n\
KU0XbxeFt17ryhkhn2rLkddkztzwrEWoC4HJjgO9bjqK2F3dkqC2sj1wvhtLKljW\n\
JZAzn+rzx4SI1fJKOkEP7FsfPFnyiqcr3hUA+wtxK3W1b4kHxPU757q6yh6wkTJZ\n\
bCe/TXH5tOU429Y4Gn/aO0evAbyeUSO7J9SififRtJ3FT0+9iuvbWV5hey20/3l9\n\
Fxwo1skCgYEA+akmdCldz5IHYfzxIGONmcbWZwfZ6mCFfKXVUuK320jPrW/DNIuM\n\
WP9OAbw94fbKAwbGsvtIInvEM14Uux3G1Yy4+XQwoTyzU3T5R4+WK31jcOAs3LDk\n\
A9ati9RYGITItd78qRRZyrUSuhyhXIxJoZrzMCm/UDqZsSyjwfmtmR8CgYEAy0mG\n\
PqJXXg7NpWcTrL8sh+bx/CIdfyGrfFB68VM1GTrR0CWLvHQVyruxyVDkjyFOJjoJ\n\
pq7BdpUCdXYNhwsS4sLo/dzaND8snWk2Wsn/MQa3ah2bK/RwGT4DZYCnEWCqE7Ep\n\
lQ4IJPpz2pTzZqR/R4fSV+JV14yBmkyo8ETxbxkCgYBeIb7T8XzjdIXAFmS7940+\n\
O9A/DKDHVBlAhC5IkB8OWQektwz81NjX/XrmAJm8hxZnybhFZ6UtC0lQrNpYKsP7\n\
ZJGhzINBZ+edQe9zYdoXD7Hcr0l69F8ka18H58pHhFlA6ZCOF5Q7b8Zd0cmtYV+p\n\
xQiIUlVF5LJqMRCVZJRltQKBgQDBmNK1IYvMspJcG+8by7CP+Hupn5+xrBIRQN/k\n\
pVZjIaYg8TDDl1YNjXSCAXy5ZoFzXEBGshTiZoRB8txtKDmjJPYYldRkf2lwu3sd\n\
OVPDj97quylE0fRTxcAcUUpJ/WHbgRPVtNhCxxXAK6wlqzDfoVTLh2wy68edd7ZH\n\
o5C+OQKBgGN+oZDagmJ1QT9BWYDmNh4N8UzbEyYaaXIUz0zs0/jeRbZqBhOsK0YN\n\
H2KKM6tSnhOXK4Tcc/1Sh50YAUQ3Y2krz7jfVJ/8qcMww34AhRNChPRC3ydMJG1X\n\
jO83HYFKYW/cF/lutzpQ7EiXaXGYEonfqKgOM5KABAvFq16GSKmJ\n\
-----END RSA PRIVATE KEY-----\n";

/// An ECDSA P-256 leaf, CN=ace, signed by ROOT_CERT.
pub(crate) const EC_LEAF_CERT: &str = "\
-----BEGIN CERTIFICATE-----\n\
MIIBhjCCASugAwIBAgIUVL5+Ji1wHkpFTMIbMnSn74mFb5YwCgYIKoZIzj0EAwIw\n\
GDEWMBQGA1UEAwwNYWNlIHRlc3Qgcm9vdDAeFw0yNjExMjQxMzQ0NTlaFw0zNjEx\n\
MjExMzQ0NTlaMA4xDDAKBgNVBAMMA2FjZTBZMBMGByqGSM49AgEGCCqGSM49AwEH\n\
A0IABOmOx4QgvagE1bMbXj3TguiWAc+es01EGYMA/DDtfvk3pfnw/PO03caAWSge\n\
wGyvmOgdHQvZtkMtXHTh/tQkMFejXTBbMAkGA1UdEwQCMAAwDgYDVR0RBAcwBYID\n\
YWNlMB0GA1UdDgQWBBReD74IV+BhlkroYKZiNZuvAf6NVjAfBgNVHSMEGDAWgBQ5\n\
llsB/RHRSSQBJabTAhCe/ChdQjAKBggqhkjOPQQDAgNJADBGAiEAokSjqogM8RaQ\n\
mO9xJp/7o/Mc8hkDZD0RojEbwE2hPoECIQCqYWDOGGnMOP42foHF0BAcRrgFvWdJ\n\
DFQiWotj/ezjXA==\n\
-----END CERTIFICATE-----\n";

/// The leaf's key, SEC1 (`BEGIN EC PRIVATE KEY`): Tailscale's certificate shape.
pub(crate) const EC_LEAF_KEY: &str = "\
-----BEGIN EC PRIVATE KEY-----\n\
MHcCAQEEIMExTTiIA03Zp56zf3vmDdwAh8WHgY3/RIBjQh/kinaXoAoGCCqGSM49\n\
AwEHoUQDQgAE6Y7HhCC9qATVsxtePdOC6JYBz56zTUQZgwD8MO1++Tel+fD887Td\n\
xoBZKB7AbK+Y6B0dC9m2Qy1cdOH+1CQwVw==\n\
-----END EC PRIVATE KEY-----\n";

/// The root that signed EC_LEAF_CERT: the second certificate of the two-certificate chain.
pub(crate) const ROOT_CERT: &str = "\
-----BEGIN CERTIFICATE-----\n\
MIIBhDCCASugAwIBAgIUdNqtlwzNOhjLWJlrSMI7WsroLyUwCgYIKoZIzj0EAwIw\n\
GDEWMBQGA1UEAwwNYWNlIHRlc3Qgcm9vdDAeFw0yNjExMjQxMjE3MzRaFw0zNjEx\n\
MjExMjE3MzRaMBgxFjAUBgNVBAMMDWFjZSB0ZXN0IHJvb3QwWTATBgcqhkjOPQIB\n\
BggqhkjOPQMBBwNCAASsDlcyK5fCFeaM0nBwJsc2M3+bow8vV7usEYDLtOVofb1Y\n\
6SYHSk6G+vWKwNCw11KJbEx5sNunFHPHWiAiCsAWo1MwUTAdBgNVHQ4EFgQUOZZb\n\
Af0R0UkkASWm0wIQnvwoXUIwHwYDVR0jBBgwFoAUOZZbAf0R0UkkASWm0wIQnvwo\n\
XUIwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBEAiBr/gHkGLL/TCua\n\
46MPFEompa5mvtdlH8QIplt5IbiAAwIgN+0otkI5A+RE2bIrQ3LVq3s7SYnCisOF\n\
yS64JDHCnws=\n\
-----END CERTIFICATE-----\n";
