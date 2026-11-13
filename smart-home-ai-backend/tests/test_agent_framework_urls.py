import unittest

from app.services.agent_framework import derive_dify_base_url


class AgentFrameworkUrlTests(unittest.TestCase):
    def test_derives_base_url_from_local_dify_workflow_console_url(self):
        url = "http://dify.local/app/example-app-id/workflow"

        self.assertEqual(derive_dify_base_url(url), "http://dify.local")

    def test_keeps_legacy_public_chat_url_compatible(self):
        url = "https://dify.example.com/chat/example-share-id"

        self.assertEqual(derive_dify_base_url(url), "https://dify.example.com")


if __name__ == "__main__":
    unittest.main()
