poetry env use python3.14
poetry install
poetry run nodeenv -n lts .nodevenv
npx -y npm@11 install
