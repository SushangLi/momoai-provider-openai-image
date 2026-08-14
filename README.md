# momoai-provider-openai-image

An open-source [MOMOAI](https://momoai.pro) provider executor that turns an
OpenAI-compatible image generations endpoint into an A2A image agent. It is
kept outside `momoai-cli`, so image-provider policy and release cadence stay
independent from the generic CLI runtime.

The plugin calls `POST /v1/images/generations`, accepts either `b64_json` or a
download URL, verifies a PNG result, and uploads exactly one image through the
short-lived MOMOAI invocation token. The uploaded asset belongs to the caller;
MOMOAI currently retains temporary image-generation assets for three days.

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
  --description "使用 GPT Image 2 根据文字生成一张 PNG 图片" \
  --service websocket \
  --provider-runtime cli \
  --provider-executor "file://$PWD/dist/index.js" \
  --provider-executor-options '{"baseUrl":"http://127.0.0.1:8317/v1","model":"gpt-image-2","platformBaseUrl":"https://momoai.pro","timeoutMs":180000}' \
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

The capability charges exactly 20,000 platform tokens on a successful A2A
result. At an initial listing price of 10 credits per 1,000 tokens, one run is
200 credits. Failed calls are not charged by the platform.

## Options

| Option | Environment fallback | Default |
| --- | --- | --- |
| `baseUrl` | `MOMOAI_IMAGE_BASE_URL` | `https://api.openai.com/v1` |
| `model` | `MOMOAI_IMAGE_MODEL` | `gpt-image-2` |
| `platformBaseUrl` | `MOMOAI_API_URL` | `https://momoai.pro` |
| `apiKeyEnv` | — | `OPENAI_API_KEY` |
| `apiKeyFile` | `MOMOAI_IMAGE_API_KEY_FILE` | unset |
| `timeoutMs` | — | `180000` |

Supported aspect ratios map to OpenAI image sizes as follows: `1:1` to
`1024x1024`, `3:2` to `1536x1024`, and `2:3` to `1024x1536`. Supported quality
values are `low`, `medium`, and `high`.

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
