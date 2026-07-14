# Idempotent: bail if devenv.bash has already been sourced in this shell.
# Without this guard, a second source re-runs `.venv/bin/activate`, whose
# top-level `deactivate () {}` then collides with the `alias deactivate=...`
# this script installs on first source — zsh's parser rejects redefining
# an existing alias as a function. (Triggered when ~/.zshrc sources the
# project .zshrc more than once, e.g. recursive walker + toolbox hook.)
[ -n "$JOBFINDER_DEVENV_LOADED" ] && return
export JOBFINDER_DEVENV_LOADED=1

export WS_DIR=${WS_DIR:-"$(./wsdir.bash)"}
unset npm_config_prefix NPM_CONFIG_PREFIX

VIRTUAL_ENV_DISABLE_PROMPT=1
NODE_VIRTUAL_ENV_DISABLE_PROMPT=1
source "$WS_DIR/.nodevenv/bin/activate"
source "$WS_DIR/.venv/bin/activate"

NPM_BIN="$(npx -y npm@8 bin)"

if [ -z "$PROJ_VIRTUAL_ENV_DISABLE_PROMPT" ] ; then
    _OLD_NODE_VIRTUAL_PS1="$PS1"
    PS1="(v) $PS1"
    export PS1
fi

pathadd() {
    if [ -d "$1" ] && [[ ":$PATH:" != *":$1:"* ]]; then
        export PATH="$1${PATH:+":$PATH"}"
    fi
}

pathadd "$NPM_BIN"
pathadd "$WS_DIR/bin"

alias deactivate="deactivate && deactivate_node"
