UUID = gmeetminder@afreiberger.github.io
SRC = $(UUID)
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all schemas test install uninstall enable disable pack lint logs

all: schemas

# Compile the GSettings schema (required before the extension can load).
schemas:
	glib-compile-schemas $(SRC)/schemas

# Run pure-logic unit tests under gjs.
test:
	gjs -m tests/runner.js

# Install into the user extensions dir (copies source + compiled schema).
install: schemas
	mkdir -p $(INSTALL_DIR)
	cp -r $(SRC)/. $(INSTALL_DIR)/
	@echo "Installed to $(INSTALL_DIR)"
	@echo "Now: log out/in (Wayland) or restart shell, then: gnome-extensions enable $(UUID)"

uninstall:
	rm -rf $(INSTALL_DIR)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

# Build a distributable zip via gnome-extensions. The schemas/ directory is
# picked up automatically; lib/ must be listed as an extra source.
pack: schemas
	gnome-extensions pack --force $(SRC) --extra-source=lib

# Tail the shell journal filtered to our extension.
logs:
	journalctl -f -o cat /usr/bin/gnome-shell | grep -i gmeetminder
