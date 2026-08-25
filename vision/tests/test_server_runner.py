import threading
import unittest

from server import run_http_server, start_application_runner


class BlockingApplication:
    def __init__(self, camera_index, headless, action_source, action_result_sink=None):
        self.camera_index = camera_index
        self.headless = headless
        self.action_source = action_source
        self.action_result_sink = action_result_sink
        self.running = threading.Event()
        self.exit_requested = threading.Event()

    def run(self):
        self.running.set()
        self.exit_requested.wait(timeout=2)

    def request_exit(self):
        self.exit_requested.set()


class ApplicationRunnerTests(unittest.TestCase):
    def test_http_server_binds_only_to_loopback(self):
        calls = []
        app = object()

        run_http_server(app, serve=lambda value, **options: calls.append((value, options)))

        self.assertEqual(calls, [(app, {"host": "127.0.0.1", "port": 8091, "threads": 8})])

    def test_stop_requests_exit_and_waits_for_runner(self):
        created = []

        def factory(**kwargs):
            app = BlockingApplication(**kwargs)
            created.append(app)
            return app

        stop = start_application_runner(
            camera_index=2,
            action_source=lambda: None,
            application_factory=factory,
        )
        self.assertTrue(created[0].running.wait(timeout=1))
        self.assertEqual(created[0].camera_index, 2)
        self.assertTrue(created[0].headless)

        stop()

        self.assertTrue(created[0].exit_requested.is_set())


if __name__ == "__main__":
    unittest.main()
