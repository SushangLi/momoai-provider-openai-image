# momoai-provider-openai-image

An open-source [MOMOAI](https://momoai.pro) provider executor that turns an
OpenAI-compatible image generations endpoint into an A2A image agent. It is
kept outside `momoai-cli`, so image-provider policy and release cadence stay
independent from the generic CLI runtime.

The plugin calls `POST /v1/images/generations` for text-only requests and
`POST /v1/images/edits` for requests containing up to 16 ordered reference
images. It requires `b64_json` output, verifies a PNG result, and uploads
exactly one image through the short-lived MOMOAI invocation token. Arbitrary
provider-returned URLs are deliberately not fetched.
The uploaded asset belongs to the caller; MOMOAI retains image-generation
assets for 30 days.

## Requirements

- Node.js 18 or newer
- A current source build of `momoai-cli` with provider-executor support
- An OpenAI-compatible endpoint that supports `gpt-image-2`

## Build

```bash
git clone https://github.com/SushangLi/momoai-provider-openai-image.git
cd momoai-provider-openai-image
npm install
npm run check
```

## Configure and publish

The example below uses a local cliproxy endpoint. The endpoint does not require
an API key; for endpoints that do, put the secret in `OPENAI_API_KEY`, set
`apiKeyEnv` to another environment variable name, or use `apiKeyFile` to point
at a local file readable only by the provider user. Never put the secret value
itself inside `providerExecutorOptions`.

```bash
momoai agent profile set imagegen \
  --name "GPT Image 2 生图" \
  --description "使用 GPT Image 2 根据文字或参考图生成一张 PNG 图片" \
  --service websocket \
  --provider-runtime cli \
  --provider-executor "file://$PWD/dist/index.js" \
  --provider-executor-options '{"baseUrl":"http://127.0.0.1:8317/v1","model":"gpt-image-2","platformBaseUrl":"https://momoai.pro","timeoutMs":180000,"referenceImageHosts":["your-bucket.oss-region.aliyuncs.com"]}' \
  --price 10 \
  --available-tokens 1000000 \
  --capabilities-file "$PWD/examples/capabilities.json"

momoai agent publish --profile imagegen
momoai agent connect --profile imagegen
```

After the provider is connected and verified, make the listing public:

```bash
momoai agent update-listing --profile imagegen --public
```

The capability charges 20,000 platform tokens plus 10,000 tokens per reference
image on a successful A2A result. At an initial listing price of 10 credits per
1,000 tokens, a text-only run is 200 credits and each reference adds 100
credits. Failed calls are not charged by the platform.

## Options

| Option | Environment fallback | Default |
| --- | --- | --- |
| `baseUrl` | `MOMOAI_IMAGE_BASE_URL` | `https://api.openai.com/v1` |
| `model` | `MOMOAI_IMAGE_MODEL` | `gpt-image-2` |
| `platformBaseUrl` | `MOMOAI_API_URL` | `https://momoai.pro` |
| `apiKeyEnv` | — | `OPENAI_API_KEY` |
| `apiKeyFile` | `MOMOAI_IMAGE_API_KEY_FILE` | unset |
| `timeoutMs` | — | `180000` |
| `referenceImageHosts` | `MOMOAI_REFERENCE_IMAGE_HOSTS` | platform API host only |

Supported aspect ratios map to OpenAI image sizes as follows: `1:1` to
`1024x1024`, `3:2` to `1536x1024`, and `2:3` to `1024x1536`. Supported quality
values are `low`, `medium`, and `high`.

Reference inputs must be standard A2A file parts with an HTTPS `file.uri`,
`metadata.asset_id`, and `metadata.role` set to `reference_image`. Only exact
hosts listed by `referenceImageHosts` are fetched. JPEG, PNG, and WebP files up
to 20 MB are accepted, and their order is preserved as repeated `image[]`
multipart fields.

## Run on macOS with launchd

Copy `examples/com.momoai.imagegen.plist` to `~/Library/LaunchAgents`, replace
the placeholder executable path, then load it:

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.momoai.imagegen.plist
launchctl kickstart -k "gui/$(id -u)/com.momoai.imagegen"
```

Do not put provider secrets in a committed plist. If your endpoint requires a
key, provide it through a local-only environment mechanism.

## License

MIT
