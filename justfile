# `just --list --unsorted`
[group('default')]
default:
    @just --list --unsorted

ci := env("CI", "")

# Install dependencies
[group('setup')]
install:
    vp install
    vp fmt CLAUDE.md

# Run dev server
dev *args: install
    vp dev {{args}}

# Run linter
lint: install
    vp lint {{ if ci != "" { "--format github" } else { "--fix" } }}

# Run formatter
format: install
    vp fmt {{ if ci != "" { "--check" } else { "" } }}

# Run checks (format + lint + typecheck)
check *args: install
    vp run --cache check {{ if ci != "" { "" } else { "--fix" } }} {{args}}

# Run tests
test *args: install
    vp run --cache test:run {{args}}

# Type-check the project
typecheck: install
    vp run --cache typecheck

# Build the project
build: install
    vp run --cache build

# Apply safe Fallow fixes locally, then reject remaining dead code
fallow: install
    {{ if ci == "" { "vp run fallow" } else { "true" } }}
    vp run fallow:ci

# vp run fallow:ci
fallow-check: install
    vp run fallow:ci

# Run Storybook
storybook *args: install
    vp run storybook {{args}}

# Run pre-commit hooks on all files (same as CI's pre-commit job)
pre-commit: install
    pre-commit run --all-files

# Run all pre-commit checks
[arg("quick", long, value="true", help="Skip tests")]
verify quick="": check build fallow pre-commit
    {{ if quick != "true" { "just test" } else { "true" } }}
    @echo "All pre-commit checks passed!"

# Deprecated alias for `verify`
[arg("quick", long, value="true", help="Skip tests")]
precommit quick="": (verify quick)

# Verify, tag, deploy to production, and push the release tag
[group('release')]
[arg("dry-run", long, value="true", help="Print the release plan without verifying, tagging, or deploying")]
release dry-run="": install
    node --experimental-strip-types scripts/release.ts {{ if dry-run == "true" { "--dry-run" } else { "" } }}
