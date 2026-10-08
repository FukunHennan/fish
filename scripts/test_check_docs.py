import unittest
from unittest.mock import patch

import check_docs


class DocsCheckTests(unittest.TestCase):
    def test_git_rename_is_counted_as_old_and_new_paths(self):
        diff = b"R100\0docs/overview/old.md\0docs/program/new.md\0M\0controller/main.go\0"
        with patch.object(check_docs, "git", return_value=diff):
            self.assertEqual(
                check_docs.changed_paths("base", "head"),
                [("D", "docs/overview/old.md"), ("A", "docs/program/new.md"), ("M", "controller/main.go")],
            )

    def test_only_relevant_categories_are_required(self):
        self.assertEqual(
            check_docs.required_categories([("M", "controller/main.go")]),
            {"程序", "开发日志"},
        )
        self.assertEqual(
            check_docs.required_categories([("M", "config/firmware.json")]),
            {"程序", "硬件", "开发日志"},
        )
        self.assertEqual(
            check_docs.required_categories([("A", "vision/new_module.py")]),
            {"程序", "概述", "开发日志"},
        )


if __name__ == "__main__":
    unittest.main()
