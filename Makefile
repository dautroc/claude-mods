# Every mod here is a plugin folder that .claude-plugin/marketplace.json lists.
# Installed from this folder, a mod is read from here, not from a copy, so an
# edit reaches a running session with /reload-plugins and no reinstall.

MARKETPLACE := claude-mods
MODS := $(shell node -e 'for (const p of require("./.claude-plugin/marketplace.json").plugins) console.log(p.name)')

.PHONY: test install

test:
	@claude plugin validate . >/dev/null || claude plugin validate .
	@for mod in $(MODS); do \
		claude plugin validate $$mod >/dev/null || { claude plugin validate $$mod; exit 1; }; \
		claude plugin test $$mod || exit 1; \
	done

# Adds this folder as the marketplace once, re-reads its list of mods, then
# installs each at user scope so every session loads it.
install:
	@claude plugin marketplace list | grep -q '❯ $(MARKETPLACE)$$' || claude plugin marketplace add $(CURDIR)
	@claude plugin marketplace update $(MARKETPLACE)
	@for mod in $(MODS); do claude plugin install $$mod@$(MARKETPLACE) --scope user || exit 1; done
	@echo "Run /reload-plugins in a running session to load the mods."
