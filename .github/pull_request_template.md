## Summary

<!-- What does this change, and why? Link any related issue. -->

## Checks

- [ ] `npm test`
- [ ] `python3 -m unittest discover -s ci/tests`
- [ ] `npm run check`
- [ ] `npm pack --dry-run`

## Notes

- [ ] Changes to `ci/wake.py` or `vendor/install.sh` include matching Python tests and workflow validation.
- [ ] Documentation is updated for user-facing changes.
- [ ] No credentials, tokens, live inventory or private state are included.
