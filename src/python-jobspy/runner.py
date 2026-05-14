"""Bridge script invoked by src/python-jobspy/index.ts.

Reads a JSON object of scrape_jobs kwargs from stdin, calls
jobspy.scrape_jobs, and writes a JSON array of records to stdout.
Progress and warnings from jobspy itself go to stderr untouched.
"""
import json
import sys

from jobspy import scrape_jobs


def main() -> int:
    opts = json.load(sys.stdin)
    df = scrape_jobs(**opts)
    sys.stdout.write(df.to_json(orient="records", date_format="iso", default_handler=str))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
