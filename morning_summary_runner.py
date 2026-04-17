"""Scheduler that runs the morning summary every day at 8:00 AM.

Usage:
    python morning_summary_runner.py           # runs on schedule (keeps process alive)
    python morning_summary_runner.py --now     # run once immediately and exit
"""

import argparse
import logging
import sys

import schedule
import time

from sdk_agent.morning_summary import print_morning_summary

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

SUMMARY_TIME = "08:00"


def _run_summary() -> None:
    try:
        print_morning_summary()
    except Exception as exc:
        log.error("Morning summary failed: %s", exc, exc_info=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Morning summary scheduler")
    parser.add_argument(
        "--now",
        action="store_true",
        help="Run the summary immediately instead of waiting for 8 AM",
    )
    args = parser.parse_args()

    if args.now:
        log.info("Running morning summary immediately...")
        _run_summary()
        return

    schedule.every().day.at(SUMMARY_TIME).do(_run_summary)
    log.info("Morning summary scheduled daily at %s. Press Ctrl+C to stop.", SUMMARY_TIME)

    try:
        while True:
            schedule.run_pending()
            time.sleep(30)
    except KeyboardInterrupt:
        log.info("Scheduler stopped.")
        sys.exit(0)


if __name__ == "__main__":
    main()
