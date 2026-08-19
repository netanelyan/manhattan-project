# Manhattan. POSIX make; every target is a thin wrapper around tools/dev.js so
# that `make` and `npm run` cannot drift, and so a machine without make (a stock
# Git Bash on Windows, for one) still has the whole workflow through npm.
#
#   make dev                     generate if needed, verify, serve
#   make gen COUNT=20m BLOCKS=9  parameters override on the command line
#
# No GNU extensions, no shell built-ins, forward slashes only.

COUNT  = 5m
BLOCKS = 70
SEED   = 42
PORT   = 8080
DATA   = data

DEV = node tools/dev.js
ARGS = --count $(COUNT) --blocks $(BLOCKS) --seed $(SEED) --port $(PORT) --data $(DATA)

help:
	@$(DEV) help

dev:
	@$(DEV) dev $(ARGS)

gen:
	@$(DEV) gen $(ARGS)

big:
	@$(DEV) big $(ARGS)

block:
	@$(DEV) block $(ARGS)

verify:
	@$(DEV) verify $(ARGS)

serve:
	@$(DEV) serve $(ARGS)

bench:
	@$(DEV) bench $(ARGS)

clean:
	@$(DEV) clean $(ARGS)

.PHONY: help dev gen big block verify serve bench clean
