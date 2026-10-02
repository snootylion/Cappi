# SPDX-License-Identifier: Apache-2.0
"""Deterministic counterexamples for honest runtime/native/APK evidence."""
import copy
import importlib.util
from pathlib import Path
import json
import os
import subprocess
import unittest

TOOLS = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class NativeProofTest(unittest.TestCase):
    def setUp(self):
        self.validator = load('native_proof', TOOLS / 'lib/native-proof.py')
        def ev(kind, seq, data):
            return {'type': 'event', 'event': {'type': kind, 'seq': seq, 'data': data}}
        self.proof = {'ok': True, 'baselineCursor': 10, 'expectedEcho': 'native synthetic reply',
                      'finals': [{'kind': 'final', 'streamId': 'current-stream', 'utteranceId': 'current-utterance', 'text': 'turnkey voice check'}],
                      'syntheses': [{'speechId': 'new-speech', 'text': 'native synthetic reply'}],
                      'snapshot': {'records': [ev('turn/start', 11, {'turn': 2}),
                                                ev('user/message', 12, {'content': [{'type': 'text', 'text': 'turnkey voice check'}]}),
                                                ev('assistant/message', 13, {'message': {'content': [{'type': 'text', 'text': 'native synthetic reply'}]}}),
                                                ev('turn/end', 14, {'turn': 2})]}}
        self.receipt = {'streamId': 'current-stream', 'utteranceId': 'current-utterance', 'delivered': True, 'ackFinals': 1}
        self.frames = [{'t': 'assistant', 'text': 'native synthetic reply', 'done': True}, {'t': 'session', 'running': True},
                       {'t': 'speech-started', 'speechId': 'new-speech'}, {'t': 'audio', 'speechId': 'new-speech', 'pcmBase64': 'AA=='},
                       {'t': 'audio-done', 'speechId': 'new-speech', 'cancelled': False}]

    def test_fresh_correlated_chain(self):
        self.assertEqual(12, self.validator.validate(self.proof, self.receipt, self.frames)['userSeq'])

    def test_stale_snapshot_cannot_pass(self):
        self.proof['baselineCursor'] = 14
        with self.assertRaises(AssertionError): self.validator.validate(self.proof, self.receipt, self.frames)

    def test_wrong_recognized_text_cannot_pass(self):
        self.proof['finals'][0]['text'] = 'other text'
        with self.assertRaises(AssertionError): self.validator.validate(self.proof, self.receipt, self.frames)

    def test_wrong_utterance_cannot_pass(self):
        self.receipt['utteranceId'] = 'old-utterance'
        with self.assertRaises(AssertionError): self.validator.validate(self.proof, self.receipt, self.frames)

    def test_prior_assistant_cannot_pass(self):
        self.frames[0]['text'] = 'route-ok prior fixture'
        with self.assertRaises(AssertionError): self.validator.validate(self.proof, self.receipt, self.frames)

    def test_prior_speech_id_cannot_pass(self):
        for f in self.frames:
            if 'speechId' in f: f['speechId'] = 'old-speech'
        with self.assertRaises(AssertionError): self.validator.validate(self.proof, self.receipt, self.frames)

    def test_incomplete_turn_cannot_pass(self):
        self.proof['snapshot']['records'].pop()
        with self.assertRaises(AssertionError): self.validator.validate(self.proof, self.receipt, self.frames)

    def test_duplicate_native_final_cannot_pass(self):
        self.proof['finals'].append(copy.deepcopy(self.proof['finals'][0]))
        with self.assertRaises(AssertionError): self.validator.validate(self.proof, self.receipt, self.frames)


class CallbackProofTest(unittest.TestCase):
    def setUp(self):
        self.mod = load('callback_proof', TOOLS / 'lib/callback-proof.py')
        def ev(kind, seq, data): return {'type': 'event', 'event': {'type': kind, 'seq': seq, 'data': data}}
        self.proof = {'ok': True, 'kind': 'approval', 'baselineCursor': 10, 'callId': 'fixture-call', 'snapshot': {'records': [
            ev('turn/start', 11, {'turn': 2}),
            ev('user/message', 12, {'content': [{'type': 'text', 'text': 'TEST-FIXTURE callback'}]}),
            ev('tool/call', 13, {'turn': 2, 'callId': 'fixture-call', 'name': 'fixture_approval', 'arguments': '{}'}),
            ev('approval/asked', 14, {'id': 'sdk-request', 'callId': 'fixture-call'}),
            ev('approval/decided', 15, {'id': 'sdk-request', 'outcome': 'allowed-once'}),
            ev('tool/result', 16, {'turn': 2, 'message': {'content': [{'type': 'tool-result', 'toolCallId': 'fixture-call', 'content': [{'type': 'text', 'text': '{"outcome":"allowed-once"}'}]}]}}),
            ev('turn/end', 17, {'turn': 2})]}}

    def test_real_approval_audit_and_result(self):
        self.assertEqual(16, self.mod.validate(self.proof))

    def test_stale_callback_result_refused(self):
        self.proof['baselineCursor'] = 15
        with self.assertRaises(AssertionError): self.mod.validate(self.proof)

    def test_duplicate_audit_decision_refused(self):
        self.proof['snapshot']['records'].insert(5, copy.deepcopy(self.proof['snapshot']['records'][4]))
        with self.assertRaises(AssertionError): self.mod.validate(self.proof)

    def test_wrong_call_id_refused(self):
        self.proof['callId'] = 'different-call'
        with self.assertRaises(AssertionError): self.mod.validate(self.proof)

    def test_real_selected_question_answer(self):
        self.proof['kind'] = 'question'
        self.proof['snapshot']['records'][2]['event']['data']['name'] = 'ask_user_question'
        self.proof['snapshot']['records'][5]['event']['data']['message']['content'][0]['content'][0]['text'] = '{"answers":[{"id":"fixture-choice","selected":["fixture-answer"]}]}'
        self.assertEqual(16, self.mod.validate(self.proof))


    def test_idle_fake_callback_without_model_request_refused(self):
        self.proof['snapshot']['records'].pop(2)
        with self.assertRaises(AssertionError): self.mod.validate(self.proof)

    def test_result_outside_real_open_turn_refused(self):
        self.proof['snapshot']['records'][0]['event']['seq'] = 20
        with self.assertRaises(AssertionError): self.mod.validate(self.proof)


class ManagedProtocolTruthTest(unittest.TestCase):
    def setUp(self):
        self.defs = json.loads((TOOLS.parent / 'protocol/turnkey.schema.json').read_text())['definitions']

    def test_managed_receipt_schema_cannot_allow_silent_success(self):
        receipt = self.defs['audioReceipt']
        self.assertIn('delivered', receipt['required'])
        self.assertNotIn('drafted', receipt['required'])  # absent is false, per managed wire
        self.assertEqual('boolean', receipt['properties']['drafted']['type'])
        rules = receipt['allOf']
        error = next(r for r in rules if r['if']['properties'].get('state', {}).get('const') == 'error')
        self.assertEqual({'code', 'message', 'retryable'}, set(error['then']['required']))
        draft = next(r for r in rules if r['if']['properties'].get('drafted', {}).get('const') is True)
        self.assertEqual({'delivered': {'const': False}, 'ackFinals': {'const': 0}, 'state': {'const': 'closed'}}, draft['then']['properties'])
        delivered = next(r for r in rules if r['if']['properties'].get('delivered', {}).get('const') is True)
        self.assertEqual({'ackFinals': {'minimum': 1}, 'drafted': {'const': False}}, delivered['then']['properties'])
        closed = next(r for r in rules if r['if']['properties'].get('state', {}).get('const') == 'closed')
        self.assertEqual(2, len(closed['then']['anyOf']))
        self.assertEqual({'const': True}, closed['then']['anyOf'][0]['properties']['delivered'])
        self.assertIn('drafted', closed['then']['anyOf'][1]['required'])

    def test_scoped_mic_cancel_contract_is_not_agent_cancel(self):
        request, response = self.defs['micCancelRequest'], self.defs['micCancelResponse']
        self.assertEqual({'cmd', 'streamId'}, set(request['required']))
        self.assertEqual('mic-cancel', request['properties']['cmd']['const'])
        self.assertEqual('^[A-Za-z0-9_-]{1,64}$', request['properties']['streamId']['pattern'])
        self.assertEqual({'ok', 'streamId', 'cancelled'}, set(response['required']))
        self.assertEqual('boolean', response['properties']['cancelled']['type'])
        self.assertIs(False, self.defs['features']['properties']['micCancel']['default'])


class EnvironmentIsolationTest(unittest.TestCase):
    def test_real_node_child_has_no_ambient_provider_or_ssh_secrets(self):
        # All values are public TEST-FIXTURE sentinels, never inherited secrets.
        sentinels = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'AWS_SECRET_ACCESS_KEY',
                     'AZURE_TOKEN', 'PRIVATE_PROVIDER_SECRET', 'SSH_AUTH_SOCK', 'GIT_ASKPASS',
                     'HTTP_PROXY', 'NODE_OPTIONS', 'UNRECOGNIZED_PROVIDER_CREDENTIAL']
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': '/synthetic/fixture/home'}
        env.update({key: 'TEST-FIXTURE-not-a-secret' for key in sentinels})
        check = 'const names=' + json.dumps(sentinels) + ';console.log(JSON.stringify({remaining:names.filter(k=>k in process.env),homePrivate:process.env.HOME==="/tmp"}));'
        for script in ['test-vanilla-install.sh', 'smoke-clean-source.sh', 'release-bundle.sh']:
            with self.subTest(script=script):
                source = (TOOLS / script).read_text()
                start = source.index('set -eu\n')
                end = source.index('\nROOT=', start)
                bootstrap = source[start:end]
                child = subprocess.run(['/bin/sh', '-c', bootstrap + '\nnode -e ' + "'" + check + "'"],
                                       env=env, text=True, capture_output=True)
                self.assertEqual(0, child.returncode, 'actual Node child rejected unsanitized environment')
                self.assertEqual({'remaining': [], 'homePrivate': True}, json.loads(child.stdout))


class RuntimeAndApkTest(unittest.TestCase):
    def test_real_runtime_selected_for_all_children(self):
        text = (TOOLS / 'test-vanilla-install.sh').read_text()
        self.assertIn('runtime-bin/node', text)
        self.assertIn('export PATH="$TDSH/runtime-bin:$PATH"', text)
        self.assertIn('actual runtime:', text)
        self.assertIn('"$MODE" --skip-node22 "--node-bin=$NODE22_BIN"', text)
        self.assertNotIn('NODE22_STATE="pass"', text)
        self.assertIn('node22_acceptance || exit $?', text)
        self.assertIn('MATRIX PENDING', text)
        self.assertIn('NPM_CONFIG_GLOBALCONFIG=/dev/null', text)

    def test_generic_debug_subject_only(self):
        apk = load('apk', TOOLS / 'inspect-apk.py')
        self.assertTrue(apk.standard_debug_subject('CN=Android Debug, O=Android, C=US'))
        self.assertTrue(apk.standard_debug_subject('C=US, O=Android, CN=Android Debug'))
        self.assertTrue(apk.standard_debug_subject('CN=Android Debug, OU=Android, O=Android, C=US'))
        self.assertFalse(apk.standard_debug_subject('CN=Example Owner, O=Android, C=US'))
        self.assertFalse(apk.standard_debug_subject('CN=Android Debug, OU=Other, O=Android, C=US'))
        self.assertFalse(apk.standard_debug_subject('CN=Android Debug, O=Android, C=US, EMAIL=test@example.invalid'))

    def test_artifact_plan_requires_installable_debug(self):
        text = (TOOLS / 'release-bundle.sh').read_text()
        self.assertIn('debug-installable.apk', text)
        self.assertIn('release-unsigned.apk', text)
        self.assertIn('inspect-apk.py', text)
        self.assertIn('snapshot-plugin.py', text)
        self.assertIn('requires app-debug.apk', text)
        self.assertIn('CHECKSUMS.sha256', text)


if __name__ == '__main__': unittest.main()
