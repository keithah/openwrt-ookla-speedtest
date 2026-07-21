# OpenWrt Ookla Speedtest CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish a source-only OpenWrt package recipe for Ookla Speedtest CLI on Linux aarch64, armhf, and armel, with safe automatic upstream version commits.

**Architecture:** A single OpenWrt package Makefile selects one official archive and checksum from OpenWrt's `ARCH` and `CONFIG_SOFT_FLOAT` values. A dependency-free Python updater discovers complete three-architecture releases, validates archive and ELF metadata, rewrites the recipe atomically, and is driven by a scheduled GitHub Actions workflow.

**Tech Stack:** OpenWrt package Make, Python 3 standard library and `unittest`, GitHub Actions YAML, Git/GitHub CLI.

## Global Constraints

- The public GitHub repository name is `openwrt-ookla-speedtest-cli`.
- The OpenWrt package name is `ookla-speedtest-cli`; the installed command is `/usr/bin/speedtest`.
- Support exactly `linux-aarch64`, `linux-armhf`, and `linux-armel` archives.
- Download vendor archives only during OpenWrt builds or temporary CI execution; never commit binaries, archives, `.ipk` files, or download-cache content.
- Pin one SHA-256 checksum per supported archive.
- Automatic updates commit directly to `main` only after all validation succeeds.
- Use only Python's standard library for repository automation and tests.

---

## File Structure

- `Makefile`: OpenWrt metadata, target-to-vendor architecture mapping, download/checksum settings, no-op compile stage, and binary installation.
- `scripts/update_ookla.py`: release discovery, complete-release selection, archive/ELF validation, hashing, atomic recipe update, and CLI entry point.
- `tests/test_recipe.py`: evaluate package variables with a stub OpenWrt make environment and assert package metadata/install behavior.
- `tests/test_update_ookla.py`: unit tests for release parsing, completeness, version ordering, ELF checks, archive hashing, and exact recipe rewriting.
- `tests/fixtures/releases.html`: local official-page-shaped URLs containing complete, incomplete, and older releases.
- `.github/workflows/test.yml`: run unit tests on pushes and pull requests.
- `.github/workflows/update-ookla.yml`: daily/manual live update, validation, and direct bot commit.
- `.gitignore`: exclude Python caches, OpenWrt artifacts, archives, and packages.
- `README.md`: build, installation, support, update, and licensing guidance.
- `LICENSE`: MIT license for repository-authored files only.

### Task 1: OpenWrt Package Recipe

**Files:**
- Create: `Makefile`
- Create: `tests/__init__.py`
- Create: `tests/test_recipe.py`

**Interfaces:**
- Consumes: OpenWrt variables `TOPDIR`, `INCLUDE_DIR`, `ARCH`, and `CONFIG_SOFT_FLOAT`.
- Produces: `OOKLA_ARCH`, `PKG_SOURCE`, `PKG_HASH`, package metadata, and `/usr/bin/speedtest` installation.

- [ ] **Step 1: Write failing recipe tests**

Create a `unittest.TestCase` that builds a temporary stub `rules.mk` and
`package.mk`, includes the repository Makefile, and prints selected variables.
Assert these exact mappings and initial checksums:

```python
CASES = {
    ("aarch64", False): (
        "aarch64",
        "3953d231da3783e2bf8904b6dd72767c5c6e533e163d3742fd0437affa431bd3",
    ),
    ("arm", False): (
        "armhf",
        "e45fcdebbd8a185553535533dd032d6b10bc8c64eee4139b1147b9c09835d08d",
    ),
    ("arm", True): (
        "armel",
        "629a455a2879224bd0dbd4b36d8c721dda540717937e4660b4d2c966029466bf",
    ),
}
```

Also assert `PKG_VERSION=1.2.0`, `PKG_RELEASE=1`, the source filename includes
the selected vendor suffix, unsupported `x86_64` yields no supported suffix,
the dependency expression is `@(aarch64||arm)`, and the install definition
uses `$(INSTALL_BIN) $(PKG_BUILD_DIR)/speedtest $(1)/usr/bin/speedtest`.

- [ ] **Step 2: Run the focused tests and confirm the expected failure**

Run: `python3 -m unittest -v tests.test_recipe`

Expected: FAIL because the repository `Makefile` does not exist.

- [ ] **Step 3: Implement the minimal OpenWrt recipe**

Create the recipe with these concrete selections:

```make
include $(TOPDIR)/rules.mk

PKG_NAME:=ookla-speedtest-cli
PKG_VERSION:=1.2.0
PKG_RELEASE:=1

OOKLA_ARCH:=
OOKLA_HASH_aarch64:=3953d231da3783e2bf8904b6dd72767c5c6e533e163d3742fd0437affa431bd3
OOKLA_HASH_armhf:=e45fcdebbd8a185553535533dd032d6b10bc8c64eee4139b1147b9c09835d08d
OOKLA_HASH_armel:=629a455a2879224bd0dbd4b36d8c721dda540717937e4660b4d2c966029466bf

ifeq ($(ARCH),aarch64)
  OOKLA_ARCH:=aarch64
else ifeq ($(ARCH),arm)
  ifeq ($(CONFIG_SOFT_FLOAT),y)
    OOKLA_ARCH:=armel
  else
    OOKLA_ARCH:=armhf
  endif
endif

PKG_SOURCE:=ookla-speedtest-$(PKG_VERSION)-linux-$(OOKLA_ARCH).tgz
PKG_SOURCE_URL:=https://install.speedtest.net/app/cli/
PKG_HASH:=$(OOKLA_HASH_$(OOKLA_ARCH))
PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)-$(OOKLA_ARCH)
PKG_LICENSE:=Proprietary
PKG_MAINTAINER:=Keith Herrington <keith@hadm.net>

include $(INCLUDE_DIR)/package.mk
```

Define `Package/ookla-speedtest-cli` in `Utilities` with
`DEPENDS:=@(aarch64||arm)`, define a short description, override
`Build/Prepare` to extract the flat `.tgz` directly into `$(PKG_BUILD_DIR)`,
make `Build/Compile` empty, install only the executable with `INSTALL_BIN`, and
finish with `$(eval $(call BuildPackage,ookla-speedtest-cli))`.

- [ ] **Step 4: Run the recipe tests**

Run: `python3 -m unittest -v tests.test_recipe`

Expected: all recipe mapping and install assertions PASS.

- [ ] **Step 5: Commit the package slice**

```bash
git add Makefile tests/__init__.py tests/test_recipe.py
git commit -m "feat: add OpenWrt Ookla CLI package"
```

### Task 2: Safe Upstream Version Updater

**Files:**
- Create: `scripts/update_ookla.py`
- Create: `tests/test_update_ookla.py`
- Create: `tests/fixtures/releases.html`

**Interfaces:**
- Consumes: official CLI page HTML, official `.tgz` bytes, and repository `Makefile` text.
- Produces: `discover_versions(html) -> dict[str, set[str]]`, `latest_complete_release(html) -> str`, `validate_archive(arch, data) -> None`, `render_makefile(text, version, hashes) -> str`, and CLI exit code `0` on update/no-op or nonzero on invalid upstream state.

- [ ] **Step 1: Write failing release-discovery and recipe-render tests**

Use fixture URLs shaped exactly like:

```text
https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-aarch64.tgz
https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-armhf.tgz
https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-armel.tgz
https://install.speedtest.net/app/cli/ookla-speedtest-1.3.0-linux-aarch64.tgz
https://install.speedtest.net/app/cli/ookla-speedtest-1.3.0-linux-armhf.tgz
```

Test that 1.2.0 is selected because 1.3.0 is incomplete, a complete 1.10.0
sorts after 1.9.9, no complete release raises `UpdateError`, and unrelated
operating systems/architectures are ignored. Test that `render_makefile`
changes exactly one `PKG_VERSION`, resets exactly one `PKG_RELEASE`, changes
each of the three `OOKLA_HASH_*` assignments once, and preserves all unrelated
text. Duplicate or missing assignments must raise `UpdateError`.

- [ ] **Step 2: Write failing archive and ELF validation tests**

Build in-memory tarballs with a `speedtest` member whose first bytes contain
minimal ELF headers. Assert:

```python
EXPECTED_ELF = {
    "aarch64": (2, 183, None),
    "armhf": (1, 40, 0x400),
    "armel": (1, 40, 0x200),
}
```

Reject a missing `speedtest`, a directory in place of the executable, wrong
ELF class, wrong machine, opposite ARM float-ABI flag, and truncated header.
Assert archive hashing returns `hashlib.sha256(data).hexdigest()`.

- [ ] **Step 3: Run updater tests and confirm the expected failure**

Run: `python3 -m unittest -v tests.test_update_ookla`

Expected: FAIL because `scripts.update_ookla` does not exist.

- [ ] **Step 4: Implement the dependency-free updater**

Implement strict URL matching with:

```python
RELEASE_RE = re.compile(
    r"https://install\.speedtest\.net/app/cli/"
    r"ookla-speedtest-(\d+\.\d+\.\d+)-linux-"
    r"(aarch64|armhf|armel)\.tgz"
)
REQUIRED_ARCHES = frozenset(("aarch64", "armhf", "armel"))
```

Compare versions as integer triples. Download via
`urllib.request.urlopen(..., timeout=30)` and require HTTP success. Read the
`speedtest` tar member without extracting it. Validate ELF magic, class,
little-endian encoding, `e_machine`, and for ELF32 ARM the flags at byte offset
36 using `0x400` for hard float and `0x200` for soft float. Download and
validate all three archives before rendering the Makefile. Write the finished
text to a same-directory temporary file, `fsync`, then replace with
`os.replace`.

Expose CLI options:

```text
--page-url URL       default https://www.speedtest.net/apps/cli
--makefile PATH      default repository Makefile
--check              report availability without writing
```

Print `ookla-speedtest-cli is already at VERSION` for a no-op,
`new Ookla Speedtest CLI version available: OLD -> NEW` in check mode, and
`updated ookla-speedtest-cli: OLD -> NEW` after writing.

- [ ] **Step 5: Run the updater test module**

Run: `python3 -m unittest -v tests.test_update_ookla`

Expected: all discovery, rendering, tar, ELF, and checksum tests PASS.

- [ ] **Step 6: Run the whole test suite**

Run: `python3 -m unittest discover -s tests -v`

Expected: all Task 1 and Task 2 tests PASS.

- [ ] **Step 7: Commit the updater slice**

```bash
git add scripts/update_ookla.py tests/fixtures/releases.html tests/test_update_ookla.py
git commit -m "feat: automate Ookla release updates"
```

### Task 3: Continuous Integration and Direct Update Commits

**Files:**
- Create: `.github/workflows/test.yml`
- Create: `.github/workflows/update-ookla.yml`

**Interfaces:**
- Consumes: Python tests, live Ookla page/archive endpoints, and GitHub's `GITHUB_TOKEN`.
- Produces: validation checks on code changes and direct `main` commits named `chore: update Ookla Speedtest CLI to 1.3.0` (with the detected version substituted at runtime).

- [ ] **Step 1: Add a test that statically validates workflow policy**

Extend `tests/test_recipe.py` to assert the update workflow contains
`schedule`, `workflow_dispatch`, `contents: write`, a concurrency group,
`python3 scripts/update_ookla.py`, `python3 -m unittest discover -s tests -v`,
bot identity configuration, and `git push origin HEAD:main`. Assert it does not
contain artifact upload or release publishing actions.

- [ ] **Step 2: Run the workflow-policy test and confirm failure**

Run: `python3 -m unittest -v tests.test_recipe`

Expected: FAIL because `.github/workflows/update-ookla.yml` is absent.

- [ ] **Step 3: Create the validation workflow**

Create `test.yml` for pushes and pull requests with read-only contents
permission, `actions/checkout`, Python setup, and exactly:

```yaml
- name: Run tests
  run: python3 -m unittest discover -s tests -v
```

- [ ] **Step 4: Create the scheduled update workflow**

Create `update-ookla.yml` with a daily UTC cron, manual dispatch,
`permissions: contents: write`, and `concurrency.cancel-in-progress: false`.
Checkout `main`, run the updater, run the entire test suite, then use
`git diff --quiet -- Makefile` as the no-op gate. When changed, configure
`github-actions[bot]`, read the version from `Makefile`, commit only `Makefile`,
and push `HEAD:main`.

- [ ] **Step 5: Run all tests**

Run: `python3 -m unittest discover -s tests -v`

Expected: all tests PASS, including workflow policy.

- [ ] **Step 6: Commit the workflow slice**

```bash
git add .github/workflows/test.yml .github/workflows/update-ookla.yml tests/test_recipe.py
git commit -m "ci: check and apply Ookla updates"
```

### Task 4: Documentation and Repository Hygiene

**Files:**
- Create: `README.md`
- Create: `LICENSE`
- Create: `.gitignore`

**Interfaces:**
- Consumes: the completed package and workflow behavior.
- Produces: accurate user instructions and exclusions preventing accidental binary commits.

- [ ] **Step 1: Add repository hygiene assertions**

Extend `tests/test_recipe.py` to require `.gitignore` entries for `*.tgz`,
`*.ipk`, `dl/`, `bin/`, `build_dir/`, `__pycache__/`, and `*.pyc`. Add a tree
scan that fails if any tracked/workspace file has `.tgz`, `.ipk`, `.apk`,
`.bin`, or `.elf` suffix.

- [ ] **Step 2: Run the hygiene tests and confirm failure**

Run: `python3 -m unittest -v tests.test_recipe`

Expected: FAIL because `.gitignore` is absent.

- [ ] **Step 3: Write the README**

Document these exact flows:

```bash
git clone https://github.com/keithah/openwrt-ookla-speedtest-cli.git \
  package/openwrt-ookla-speedtest-cli
make menuconfig
make package/ookla-speedtest-cli/compile V=s
opkg install /tmp/ookla-speedtest-cli_*.ipk
speedtest
```

Explain the `Utilities` menu location, supported Linux ARM variants, build-time
vendor download/checksum verification, first-run EULA acceptance, automatic
daily direct updates, source-only policy, and unofficial-project status. Link
to Ookla's CLI page and EULA.

- [ ] **Step 4: Add license and ignore rules**

Use the MIT license for repository-authored recipe/automation files and state
in the README that it does not apply to Ookla's binary. Add all hygiene-test
patterns to `.gitignore`.

- [ ] **Step 5: Run all tests and inspect the repository**

Run: `python3 -m unittest discover -s tests -v`

Expected: all tests PASS.

Run: `git status --short && find . -type f -not -path './.git/*' | sort`

Expected: only intentional source, documentation, fixture, workflow, and test
files; no vendor archive, executable, or generated package.

- [ ] **Step 6: Commit documentation and hygiene**

```bash
git add .gitignore LICENSE README.md tests/test_recipe.py
git commit -m "docs: document OpenWrt package usage"
```

### Task 5: Live Verification and Public GitHub Publication

**Files:**
- Modify only if verification exposes a focused defect.

**Interfaces:**
- Consumes: official Ookla endpoints, local Git history, authenticated GitHub account.
- Produces: verified checksums/live no-op behavior and public `openwrt-ookla-speedtest-cli` repository with `main` tracking its origin.

- [ ] **Step 1: Verify tests from a clean working tree**

Run: `python3 -m unittest discover -s tests -v`

Expected: all tests PASS and `git status --short` is empty.

- [ ] **Step 2: Verify the live updater is a no-op at version 1.2.0**

Run: `python3 scripts/update_ookla.py --check`

Expected: `ookla-speedtest-cli is already at 1.2.0` while the official page
still advertises 1.2.0, with no changed files.

- [ ] **Step 3: Verify all pinned archives and ELF ABIs live**

Run the updater without `--check`; it must download all three archives only if
a newer version exists. Independently compare the version 1.2.0 hashes to the
three values in Task 1 and confirm ELF machine/float flags with the updater's
validation functions.

Expected: all checksums and ABI checks pass; no archive is written under the
repository.

- [ ] **Step 4: Review the final diff and history**

Run: `git log --oneline --decorate --max-count=10 && git status --short`

Expected: focused design/package/updater/workflow/docs commits and a clean
working tree.

- [ ] **Step 5: Create and push the public GitHub repository**

Confirm the authenticated account is `keithah`, then run:

```bash
gh repo create openwrt-ookla-speedtest-cli --public --source=. --remote=origin --push
```

Expected: GitHub reports the public repository URL, `origin` points to it, and
local `main` tracks `origin/main`.

- [ ] **Step 6: Verify remote repository and Actions configuration**

Run: `gh repo view --json nameWithOwner,isPrivate,url,defaultBranchRef`

Expected: name `openwrt-ookla-speedtest-cli`, `isPrivate: false`, and default
branch `main`. Confirm both workflow files are present on `origin/main` and the
scheduled workflow has write permission declared in its YAML.
