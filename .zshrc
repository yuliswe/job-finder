export PS1='%F{004}%~%f$ '
export WS_DIR="$(dirname $0/)"

if ! [ -d .nodevenv ]; then
cat <<EOS
If you are setting up the repo for the first time, following these steps:

1. Make sure your ~/.zshrc file has the following lines:

    if [ -f ./.zshrc ] && [ \$(pwd) != ~ ]; then
        source ./.zshrc
    fi

2. Run the following commands: (You only need to do this once.)

    ./initenv.bash

3. Start a new terminal session.

EOS
else
source "$(dirname $0/)/devenv.bash"
fi

