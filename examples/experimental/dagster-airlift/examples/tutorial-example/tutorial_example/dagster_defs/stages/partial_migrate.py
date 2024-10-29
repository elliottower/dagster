import os
from pathlib import Path

from dagster import AssetExecutionContext, AssetSpec
from dagster_airlift.core import assets_with_task_mappings
from dagster_dbt import DbtCliResource, DbtProject, dbt_assets

from tutorial_example.shared.constants import CUSTOMERS_CSV_PATH, WAREHOUSE_PATH

raw_customers_spec = AssetSpec(key=["raw_data", "raw_customers"])
export_customers_spec = AssetSpec(key="customers_csv", deps=["customers"])


def dbt_project_path() -> Path:
    env_val = os.getenv("TUTORIAL_DBT_PROJECT_DIR")
    assert env_val, "TUTORIAL_DBT_PROJECT_DIR must be set"
    return Path(env_val)


@dbt_assets(
    manifest=dbt_project_path() / "target" / "manifest.json",
    project=DbtProject(dbt_project_path()),
)
def dbt_project_assets(context: AssetExecutionContext, dbt: DbtCliResource):
    yield from dbt.cli(["build"], context=context).stream()


# start_load_factory
from dagster import AssetsDefinition, multi_asset

# completed shared utilities can be found in tutorial_example/shared/complete/load_csv_to_duckdb.py
from tutorial_example.shared.complete.load_csv_to_duckdb import (
    LoadCsvToDuckDbArgs,
    load_csv_to_duckdb,
)


def load_csv_to_duckdb_asset(spec: AssetSpec, args: LoadCsvToDuckDbArgs) -> AssetsDefinition:
    @multi_asset(name=f"load_{args.table_name}", specs=[spec])
    def _multi_asset() -> None:
        load_csv_to_duckdb(args)

    return _multi_asset


raw_customers_asset = load_csv_to_duckdb_asset(
    spec=raw_customers_spec,
    args=LoadCsvToDuckDbArgs(
        table_name="raw_customers",
        csv_path=CUSTOMERS_CSV_PATH,
        duckdb_path=WAREHOUSE_PATH,
        names=["id", "first_name", "last_name"],
        duckdb_schema="raw_data",
        duckdb_database_name="jaffle_shop",
    ),
)
# end_load_factory

# start_task_mappings
mapped_assets = assets_with_task_mappings(
    dag_id="rebuild_customers_list",
    task_mappings={
        "load_raw_customers": [raw_customers_asset],
        "build_dbt_models": [dbt_project_assets],
        "export_customers": [export_customers_spec],
    },
)
# end_task_mappings


from dagster import Definitions
from dagster_airlift.core import AirflowInstance, BasicAuthBackend, build_defs_from_airflow_instance

defs = build_defs_from_airflow_instance(
    airflow_instance=AirflowInstance(
        auth_backend=BasicAuthBackend(
            webserver_url="http://localhost:8080",
            username="admin",
            password="admin",
        ),
        name="airflow_instance_one",
    ),
    defs=Definitions(
        assets=mapped_assets,
        resources={"dbt": DbtCliResource(project_dir=dbt_project_path())},
    ),
)
