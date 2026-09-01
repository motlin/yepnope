#!/bin/bash

set -Eeuo pipefail

SCRIPT_DIR="$(command cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKETPLACE_NAME="yepnope"
PLUGIN_ID="yepnope@${MARKETPLACE_NAME}"

function require_command() {
	local command_name="$1"
	if ! command -v "$command_name" >/dev/null; then
		echo "Missing required command: ${command_name}" >&2
		exit 1
	fi
}

function install_claude_plugin() {
	require_command claude
	require_command jq

	local marketplace_json marketplace_source installed_json enabled
	marketplace_json="$(claude plugin marketplace list --json)"
	marketplace_source="$(
		jq -r --arg name "$MARKETPLACE_NAME" \
			'.[] | select(.name == $name) | (.path // .repo // "")' \
			<<<"$marketplace_json"
	)"

	if [[ -n "$marketplace_source" && "$marketplace_source" != "$SCRIPT_DIR" ]]; then
		echo "Replacing ${MARKETPLACE_NAME} with this local Claude marketplace..."
		claude plugin marketplace remove "$MARKETPLACE_NAME"
		marketplace_source=""
	fi

	if [[ "$marketplace_source" == "$SCRIPT_DIR" ]]; then
		echo "Claude marketplace ${MARKETPLACE_NAME} already points to this checkout."
	else
		echo "Adding ${MARKETPLACE_NAME} to Claude Code from this checkout..."
		claude plugin marketplace add "$SCRIPT_DIR"
	fi

	installed_json="$(claude plugin list --json 2>/dev/null || echo '[]')"
	if jq -e --arg id "$PLUGIN_ID" 'any(.[]; .id == $id)' \
		<<<"$installed_json" >/dev/null; then
		echo "Reinstalling ${PLUGIN_ID} to refresh the local cache..."
		claude plugin uninstall "$PLUGIN_ID"
	fi
	claude plugin install "$PLUGIN_ID"

	installed_json="$(claude plugin list --json)"
	enabled="$(
		jq -r --arg id "$PLUGIN_ID" \
			'.[] | select(.id == $id) | .enabled' \
			<<<"$installed_json"
	)"
	if [[ "$enabled" == "false" ]]; then
		claude plugin enable "$PLUGIN_ID"
	elif [[ "$enabled" != "true" ]]; then
		echo "${PLUGIN_ID} was not found after installation." >&2
		exit 1
	fi
}

function install_codex_plugin() {
	require_command codex
	require_command jq

	local marketplace_json marketplace_root installed_json codex_config_file
	codex_config_file="${CODEX_HOME:-$HOME/.codex}/config.toml"
	if [[ -f "$codex_config_file" ]] && \
		grep -q '^[[:space:]]*\[mcp_servers\.yepnope\][[:space:]]*$' "$codex_config_file"; then
		echo "A direct Codex MCP registration named yepnope would shadow the plugin bundle." >&2
		echo "Run 'codex mcp remove yepnope' before installing the Codex plugin." >&2
		exit 1
	fi

	marketplace_json="$(codex plugin marketplace list --json)"
	marketplace_root="$(
		jq -r --arg name "$MARKETPLACE_NAME" \
			'.marketplaces[]? | select(.name == $name) | .root' \
			<<<"$marketplace_json" | head -n 1
	)"

	if [[ -n "$marketplace_root" && "$marketplace_root" != "$SCRIPT_DIR" ]]; then
		echo "Replacing ${MARKETPLACE_NAME} with this local Codex marketplace..."
		codex plugin marketplace remove "$MARKETPLACE_NAME"
		marketplace_root=""
	fi

	if [[ "$marketplace_root" == "$SCRIPT_DIR" ]]; then
		echo "Codex marketplace ${MARKETPLACE_NAME} already points to this checkout."
	else
		echo "Adding ${MARKETPLACE_NAME} to Codex from this checkout..."
		codex plugin marketplace add "$SCRIPT_DIR"
	fi

	installed_json="$(codex plugin list --json 2>/dev/null || echo '{"installed": []}')"
	if jq -e --arg id "$PLUGIN_ID" \
		'any(.installed[]?; .pluginId == $id)' \
		<<<"$installed_json" >/dev/null; then
		echo "Reinstalling ${PLUGIN_ID} to refresh the local cache..."
		codex plugin remove "$PLUGIN_ID"
	fi
	codex plugin add "$PLUGIN_ID"
}

function print_usage() {
	echo "Usage: $0 [claude|codex|all]" >&2
}

target="${1:-all}"
if (($# > 1)); then
	print_usage
	exit 2
fi

case "$target" in
	claude)
		install_claude_plugin
		;;
	codex)
		install_codex_plugin
		;;
	all)
		install_claude_plugin
		install_codex_plugin
		;;
	*)
		print_usage
		exit 2
		;;
esac

echo "Installation complete. Start a new agent session, then authenticate YepNope when prompted."
echo "No status-line setting was created or replaced."
