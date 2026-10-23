import importlib.util
import io
from pathlib import Path
import unittest
import tempfile
import json
import urllib.error
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location(
    "instabox_ci_wake", Path(__file__).resolve().parents[1] / "wake.py"
)
wake = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wake)
MACHINE_ID = "m_" + "a" * 26


def machine(state="running", **extra):
    return {"state": state, "metadata": {"purpose": "boxci"},
            "runtime": {"ready": state == "running"}, **extra}


class WakeTest(unittest.TestCase):
    def run_wake(self, replies):
        with patch.object(wake, "request", side_effect=replies) as api, \
                patch.object(wake.time, "sleep"):
            wake.wake(MACHINE_ID, "test-key", runner_name="ci-01")
        return api

    def test_paused_vm_resumes_and_waits_for_guest_and_service(self):
        api = self.run_wake([
            machine("suspended"), {"id": "op_resume"},
            {"state": "running"},
            {"state": "succeeded"}, machine(), {"exitCode": 1},
            machine(), {"exitCode": 0},
        ])
        posts = [call.args[1] for call in api.call_args_list if call.args[0] == "POST"]
        self.assertEqual(posts.count(f"/v1/machines/{MACHINE_ID}/resume"), 1)

    def test_already_running_vm_does_not_restart(self):
        api = self.run_wake([machine(), machine(), {"exitCode": 0}])
        self.assertTrue(all(not call.args[1].endswith(("/resume", "/start"))
                            for call in api.call_args_list))

    def test_stopped_vm_uses_start(self):
        api = self.run_wake([machine("stopped"), {"id": "op_start"},
                             {"state": "succeeded"}, machine(), {"exitCode": 0}])
        self.assertEqual(api.call_args_list[1].args[1], f"/v1/machines/{MACHINE_ID}/start")

    def test_capacity_failure_stops_before_dispatching_work(self):
        with self.assertRaisesRegex(RuntimeError, "no_capacity"):
            self.run_wake([machine("suspended"), {"id": "op_resume"},
                           {"state": "failed", "error": {"code": "no_capacity"}}])

    def test_wrong_machine_is_never_changed(self):
        with patch.object(wake, "request", return_value=machine(metadata={})) as api:
            with self.assertRaisesRegex(RuntimeError, "BoxCI"):
                wake.wake(MACHINE_ID, "test-key", runner_name="ci-01")
            self.assertEqual(api.call_count, 1)
            self.assertEqual(api.call_args.args[0], "GET")

    def test_adopted_vm_uses_exact_expected_name_without_metadata(self):
        with patch.object(wake, "request", side_effect=[
                machine(name="adopted-ci", metadata={}),
                machine(name="adopted-ci", metadata={}), {"exitCode": 0}]):
            wake.wake(MACHINE_ID, "test-key", runner_name="ci-01", expected_name="adopted-ci")

    def test_renamed_vm_is_rejected_before_mutation(self):
        with patch.object(wake, "request", return_value=machine(name="other")) as api:
            with self.assertRaisesRegex(RuntimeError, "name"):
                wake.wake(MACHINE_ID, "test-key", runner_name="ci-01", expected_name="adopted-ci")
            self.assertEqual(api.call_count, 1)

    def test_runner_path_rejects_shell_or_traversal(self):
        with patch.object(wake, "request") as api:
            for name in ("../runner", "ci;id", "$(id)"):
                with self.assertRaises(ValueError):
                    wake.wake(MACHINE_ID, "key", runner_name=name)
            api.assert_not_called()

    def test_conflicting_wake_follows_existing_operation(self):
        self.run_wake([
            machine("suspended"), wake.ApiError(409, "operation_conflict"),
            machine("resuming", operationId="op_existing"),
            {"state": "succeeded"}, machine(), {"exitCode": 0},
        ])

    def test_missing_key_and_bad_machine_id_fail_without_network(self):
        with patch.object(wake, "request") as api:
            for machine_id, key in ((MACHINE_ID, ""), ("../other", "key")):
                with self.assertRaises(ValueError):
                    wake.wake(machine_id, key, runner_name="ci-01")
            api.assert_not_called()

    def test_unready_service_hits_deadline(self):
        with patch.object(wake, "request", return_value=machine()), \
                patch.object(wake.time, "monotonic", side_effect=[0, 0, 301, 301]):
            with self.assertRaises(TimeoutError):
                wake.wake(MACHINE_ID, "key", runner_name="ci-01")

    def test_network_retry_reuses_idempotency_key(self):
        opener = Mock()
        opener.open.side_effect = [
            urllib.error.URLError("connection lost after sending request"),
            io.BytesIO(b'{"id":"op_resume"}'),
        ]
        with patch.object(wake.urllib.request, "build_opener", return_value=opener), \
                patch.object(wake.time, "sleep"):
            result = wake.request("POST", "/v1/machines/example/resume", "key",
                                  wake.time.monotonic() + 60, idempotency_key="same-operation")
        self.assertEqual(result["id"], "op_resume")
        self.assertEqual(opener.open.call_count, 2)
        for call in opener.open.call_args_list:
            self.assertEqual(call.args[0].get_header("Idempotency-key"), "same-operation")

    def test_auth_failure_is_not_retried_or_printed(self):
        opener = Mock()
        opener.open.side_effect = urllib.error.HTTPError(
            wake.API, 401, "Unauthorized", {},
            io.BytesIO(b'{"code":"invalid_api_key","message":"secret details"}'),
        )
        with patch.object(wake.urllib.request, "build_opener", return_value=opener):
            with self.assertRaisesRegex(wake.ApiError, "invalid_api_key") as error:
                wake.request("GET", "/v1/machines/example", "test-secret",
                             wake.time.monotonic() + 60)
        opener.open.assert_called_once()
        self.assertNotIn("secret", str(error.exception))


class RoutingTest(unittest.TestCase):
    def route(self, **changes):
        args = dict(machine_id=MACHINE_ID, key="test-key", runner_name="ci-01",
                    expected_name="ci-vm", runner_label="dedicated-ci",
                    fallback_label="blacksmith-4vcpu-ubuntu-2404", trusted=True)
        args.update(changes)
        with tempfile.NamedTemporaryFile() as output:
            result = wake.route(**args, output=output.name)
            data = Path(output.name).read_text()
            self.assertEqual(json.loads(data.removeprefix("runner=")), result)
            return result

    def test_ready_machine_routes_to_dedicated_label(self):
        with patch.object(wake, "wake") as check:
            self.assertEqual(self.route(), ["self-hosted", "Linux", "dedicated-ci"])
            check.assert_called_once()

    def test_capacity_timeout_and_missing_secret_route_to_hosted(self):
        for error in (RuntimeError("capacity"), TimeoutError("deadline"), ValueError("key missing")):
            with self.subTest(error=type(error).__name__):
                with patch.object(wake, "wake", side_effect=error):
                    self.assertEqual(self.route(), ["blacksmith-4vcpu-ubuntu-2404"])

    def test_untrusted_source_never_touches_cloud(self):
        with patch.object(wake, "wake") as check:
            self.assertEqual(self.route(trusted=False), ["blacksmith-4vcpu-ubuntu-2404"])
            check.assert_not_called()

    def test_generic_label_never_routes_self_hosted(self):
        with patch.object(wake, "wake") as check:
            self.assertEqual(self.route(runner_label="Linux"), ["blacksmith-4vcpu-ubuntu-2404"])
            check.assert_not_called()

    def test_fallback_must_be_a_single_valid_label(self):
        with patch.object(wake, "wake") as check:
            with self.assertRaises(ValueError):
                self.route(fallback_label='["self-hosted"]')
            check.assert_not_called()


class PoolRoutingTest(unittest.TestCase):
    def setUp(self):
        self.pool = [dict(machine_id='m_' + c * 26, runner_name=f'ci-{i}', expected_name=f'vm-{i}')
                     for i,c in enumerate('abc',1)]

    def route(self, pool=None, trusted=True):
        with tempfile.NamedTemporaryFile() as output:
            result = wake.route_pool(json.dumps(self.pool if pool is None else pool), 'fixture-key',
                                     'dedicated-pool', 'ubuntu-24.04', trusted, output.name)
            self.assertEqual(json.loads(Path(output.name).read_text().removeprefix('runner=')), result)
            return result

    def test_all_three_wake_concurrently_before_pool_is_selected(self):
        import threading
        barrier = threading.Barrier(3)
        def wait_for_other_vms(*args, **kwargs):
            barrier.wait(timeout=3)
        with patch.object(wake, 'wake', side_effect=wait_for_other_vms) as check:
            self.assertEqual(self.route(), ['self-hosted', 'Linux', 'dedicated-pool'])
            self.assertEqual(check.call_count, 3)

    def test_partial_failure_still_attempts_all_vms_and_uses_hosted(self):
        def fail_one(mid, *args, **kwargs):
            if mid == self.pool[1]['machine_id']:
                raise TimeoutError('fixture capacity failure')
        with patch.object(wake, 'wake', side_effect=fail_one) as check:
            self.assertEqual(self.route(), ['ubuntu-24.04'])
            self.assertEqual(check.call_count, 3)

    def test_entire_pool_validated_before_any_wake(self):
        bad = [self.pool[0], dict(self.pool[1], machine_id='../dev')]
        with patch.object(wake, 'wake') as check:
            self.assertEqual(self.route(bad), ['ubuntu-24.04'])
            check.assert_not_called()

    def test_duplicate_vm_or_runner_missing_name_and_oversized_pool_are_rejected(self):
        cases = [[], [self.pool[0]]*2, self.pool*2,
                 [self.pool[0], dict(self.pool[1], runner_name='CI-1')],
                 [dict(self.pool[0], expected_name='')], [None], {}]
        with patch.object(wake, 'wake') as check:
            for pool in cases:
                with self.subTest(pool=pool):
                    self.assertEqual(self.route(pool), ['ubuntu-24.04'])
            check.assert_not_called()

    def test_fork_never_parses_pool_or_touches_provider(self):
        with patch.object(wake, 'wake') as check:
            self.assertEqual(self.route({'bad':'untrusted'}, trusted=False), ['ubuntu-24.04'])
            check.assert_not_called()

    def test_account_scoped_runner_names_keep_exact_vm_and_service_checks(self):
        self.pool = [dict(machine_id=MACHINE_ID,
                          runner_name='boxci-0123456789-01',
                          expected_name='boxci-0123456789-01')]
        with patch.object(wake, 'wake') as check:
            self.assertEqual(self.route(), ['self-hosted', 'Linux', 'dedicated-pool'])
            self.assertEqual(check.call_args.kwargs['runner_name'], self.pool[0]['runner_name'])
            self.assertEqual(check.call_args.kwargs['expected_name'], self.pool[0]['expected_name'])

    def test_previous_account_pool_unavailable_to_key_falls_back_without_mutation(self):
        with patch.object(wake, 'request', side_effect=wake.ApiError(404, 'machine_not_found')) as api:
            self.assertEqual(self.route(), ['ubuntu-24.04'])
            self.assertEqual(api.call_count, len(self.pool))
            self.assertTrue(all(call.args[0] == 'GET' for call in api.call_args_list))


if __name__ == "__main__":
    unittest.main()
