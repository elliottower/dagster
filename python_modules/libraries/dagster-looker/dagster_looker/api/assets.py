from typing import Sequence, Type, cast

from dagster import AssetExecutionContext, AssetsDefinition, Failure, multi_asset
from dagster._annotations import experimental
from dagster._core.definitions.asset_spec import AssetSpec
from looker_sdk.sdk.api40.models import ScheduledPlanDestination, WriteScheduledPlan

from dagster_looker.api.dagster_looker_api_translator import (
    DagsterLookerApiTranslator,
    DagsterLookerMetadataSet,
    LookerStructureData,
    LookerStructureType,
    LookmlView,
    RequestStartPdtBuild,
)
from dagster_looker.api.resource import LookerResource


@experimental
def build_looker_pdt_assets_definitions(
    resource_key: str,
    request_start_pdt_builds: Sequence[RequestStartPdtBuild],
    dagster_looker_translator: Type[DagsterLookerApiTranslator] = DagsterLookerApiTranslator,
) -> Sequence[AssetsDefinition]:
    """Returns the AssetsDefinitions of the executable assets for the given the list of refreshable PDTs.

    Args:
        resource_key (str): The resource key to use for the Looker resource.
        request_start_pdt_builds (Optional[Sequence[RequestStartPdtBuild]]): A list of requests to start PDT builds.
            See https://developers.looker.com/api/explorer/4.0/types/DerivedTable/RequestStartPdtBuild?sdk=py
            for documentation on all available fields.
        dagster_looker_translator (Optional[DagsterLookerApiTranslator]): The translator to
            use to convert Looker structures into assets. Defaults to DagsterLookerApiTranslator.

    Returns:
        AssetsDefinition: The AssetsDefinitions of the executable assets for the given the list of refreshable PDTs.
    """
    translator = dagster_looker_translator(None)
    result = []
    for request_start_pdt_build in request_start_pdt_builds:

        @multi_asset(
            specs=[
                translator.get_asset_spec(
                    LookerStructureData(
                        structure_type=LookerStructureType.VIEW,
                        data=LookmlView(
                            view_name=request_start_pdt_build.view_name,
                            sql_table_name=None,
                        ),
                    )
                )
            ],
            name=f"{request_start_pdt_build.model_name}_{request_start_pdt_build.view_name}",
            required_resource_keys={resource_key},
        )
        def pdts(context: AssetExecutionContext):
            looker = cast(LookerResource, getattr(context.resources, resource_key))

            context.log.info(
                f"Starting pdt build for Looker view `{request_start_pdt_build.view_name}` "
                f"in Looker model `{request_start_pdt_build.model_name}`."
            )

            materialize_pdt = looker.get_sdk().start_pdt_build(
                model_name=request_start_pdt_build.model_name,
                view_name=request_start_pdt_build.view_name,
                force_rebuild=request_start_pdt_build.force_rebuild,
                force_full_incremental=request_start_pdt_build.force_full_incremental,
                workspace=request_start_pdt_build.workspace,
                source=f"Dagster run {context.run_id}"
                if context.run_id
                else request_start_pdt_build.source,
            )

            if not materialize_pdt.materialization_id:
                raise Failure("No materialization id was returned from Looker API.")

            check_pdt = looker.get_sdk().check_pdt_build(
                materialization_id=materialize_pdt.materialization_id
            )

            context.log.info(
                f"Materialization id: {check_pdt.materialization_id}, "
                f"response text: {check_pdt.resp_text}"
            )

        result.append(pdts)

    return result


def build_dashboard_notification_assets_definition(
    resource_key: str,
    asset_spec: AssetSpec,
    destination: ScheduledPlanDestination,
) -> AssetsDefinition:
    """Bulds an AssetsDefinition for a Looker dashboard which, when materialized, will refresh the
    dashboard and send out a notification specified by the passed ScheduledPlanDestination.

    Args:
        resource_key (str): The resource key to use for the Looker resource.
        asset_spec (AssetSpec): The asset spec for the Looker dashboard.
        destination (ScheduledPlanDestination): The destination to send the notification to.
            See https://cloud.google.com/looker/docs/reference/looker-api/latest/types/ScheduledPlanDestination
    for documentation on all available fields.
    """
    looker_data = DagsterLookerMetadataSet.extract(asset_spec.metadata)

    @multi_asset(
        specs=[asset_spec],
        name=f"{asset_spec.key.to_python_identifier()}_notify",
        required_resource_keys={resource_key},
    )
    def notify(context: AssetExecutionContext):
        looker = cast("LookerResource", getattr(context.resources, resource_key))

        looker.get_sdk().scheduled_plan_run_once(
            WriteScheduledPlan(
                dashboard_id=looker_data.id, scheduled_plan_destination=[destination]
            )
        )

    return notify
