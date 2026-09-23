# Contributing

ledgerchat is deliberately small: a loopback web server, four screens, six
read-only tools and one local model. Changes that keep it that way are
welcome; hosted accounts, cloud providers and planning features live in the
maintainers' hosted product and are out of scope here.

## Checks

```sh
nvm use && pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm format      # Prettier, before you commit
```

CI runs the first three on every pull request. Add or adjust a test beside the
code you change; the suite runs against in-memory SQLite and fakes the model,
so it needs no server.

## Licence

Please submit only work you have the right to license under the
[Elastic License 2.0](LICENSE). By submitting a contribution, you agree to
license it under that licence. You keep your copyright; the maintainers do
not ask for a copyright assignment or CLA.

Code flows one way: the maintainers may publish code from their hosted product
here, but do not copy community contributions back into it without the
contributor's separate permission.
