.PHONY: build test package install clean watch

build:
	npm run compile

test:
	npm test

package: build
	npm run package

install: package
	code --install-extension $$(ls -t *.vsix | head -1)

clean:
	rm -rf out/ out-test/ *.vsix

watch:
	npm run watch
