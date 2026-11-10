"""The Worker child that serves the scripted agent."""

from dex_agents.testing import run_agent_worker

from tests.scripted_agent import build_scripted_agent_flow

if __name__ == "__main__":
    run_agent_worker([build_scripted_agent_flow()])
