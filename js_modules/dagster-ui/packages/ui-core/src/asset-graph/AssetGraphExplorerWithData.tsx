import {
  Box,
  Button,
  Checkbox,
  Colors,
  ErrorBoundary,
  ExpandCollapseButton,
  Icon,
  Menu,
  MenuItem,
  SPLIT_PANEL_ANIMATION_MS,
  SplitPanelContainer,
  Tooltip,
  usePanelInteractions,
} from '@dagster-io/ui-components';
import pickBy from 'lodash/pickBy';
import uniq from 'lodash/uniq';
import without from 'lodash/without';
import * as React from 'react';
import {AssetEdges} from './AssetEdges';
import {AssetGraphJobSidebar} from './AssetGraphJobSidebar';
import {AssetNode, AssetNodeContextMenuWrapper, AssetNodeMinimal} from './AssetNode';
import {CollapsedGroupNode} from './CollapsedGroupNode';
import {ContextMenuWrapper} from './ContextMenuWrapper';
import {ExpandedGroupNode} from './ExpandedGroupNode';
import {AssetNodeLink} from './ForeignNode';
import {GraphNode, groupIdForNode, isGroupId, tokenForAssetKey} from './Utils';
import {assetKeyTokensInRange} from './assetKeyTokensInRange';
import {AssetGraphLayout, GroupLayout} from './layout';
import {AssetGraphExplorerSidebar} from './sidebar/Sidebar';
import {useFindAssetLocation} from './useFindAssetLocation';
import {ShortcutHandler} from '../app/ShortcutHandler';
import {AssetLiveDataRefresh} from '../asset-data/AssetLiveDataProvider';
import {LaunchAssetExecutionButton} from '../assets/LaunchAssetExecutionButton';
import {LaunchAssetObservationButton} from '../assets/LaunchAssetObservationButton';
import {DEFAULT_MAX_ZOOM, SVGViewport} from '../graph/SVGViewport';
import {useAssetLayout} from '../graph/asyncGraphLayout';
import {closestNodeInDirection, isNodeOffscreen} from '../graph/common';
import {useQueryAndLocalStoragePersistedState} from '../hooks/useQueryAndLocalStoragePersistedState';
import {OptionsOverlay, RightInfoPanel, RightInfoPanelContent} from '../pipelines/GraphExplorer';
import {EmptyDAGNotice, EntirelyFilteredDAGNotice, LoadingNotice} from '../pipelines/GraphNotices';
import {GraphQueryInput} from '../ui/GraphQueryInput';
import {AssetView} from '../assets/AssetView';
import {
  WithDataProps,
  KeyboardTag,
  SVGContainer,
  MINIMAL_SCALE,
  GROUPS_ONLY_SCALE,
  TopbarWrapper,
  GraphQueryInputFlexWrap,
} from './AssetGraphExplorer';

export const AssetGraphExplorerWithData = ({
  options,
  setOptions,
  explorerPath,
  onChangeExplorerPath,
  onNavigateToSourceAssetNode: onNavigateToSourceAssetNode,
  assetGraphData,
  fullAssetGraphData,
  graphQueryItems,
  fetchOptions,
  allAssetKeys,
  filterButton,
  filterBar,
  filters,
  setFilters,
  isGlobalGraph = false,
  trace,
}: WithDataProps) => {
  const findAssetLocation = useFindAssetLocation();
  const [highlighted, setHighlighted] = React.useState<string[] | null>(null);

  const {allGroups, allGroupCounts, groupedAssets} = React.useMemo(() => {
    const groupedAssets: Record<string, GraphNode[]> = {};
    Object.values(assetGraphData.nodes).forEach((node) => {
      const groupId = groupIdForNode(node);
      groupedAssets[groupId] = groupedAssets[groupId] || [];
      groupedAssets[groupId]!.push(node);
    });
    const counts: Record<string, number> = {};
    Object.keys(groupedAssets).forEach((key) => (counts[key] = groupedAssets[key]!.length));
    return {allGroups: Object.keys(groupedAssets), allGroupCounts: counts, groupedAssets};
  }, [assetGraphData]);

  const [expandedGroups, setExpandedGroups] = useQueryAndLocalStoragePersistedState<string[]>({
    localStorageKey: `asset-graph-open-graph-nodes-${isGlobalGraph}-${explorerPath.pipelineName}`,
    encode: (arr) => ({expanded: arr.length ? arr.join(',') : undefined}),
    decode: (qs) => (qs.expanded || '').split(',').filter(Boolean),
    isEmptyState: (val) => val.length === 0,
  });
  const focusGroupIdAfterLayoutRef = React.useRef('');

  const {layout, loading, async} = useAssetLayout(assetGraphData, expandedGroups);

  React.useEffect(() => {
    if (!loading) {
      trace?.endTrace();
    }
  }, [loading, trace]);

  const viewportEl = React.useRef<SVGViewport>();

  const selectedTokens = explorerPath.opNames[explorerPath.opNames.length - 1]!.split(',');
  const selectedGraphNodes = Object.values(assetGraphData.nodes).filter((node) =>
    selectedTokens.includes(tokenForAssetKey(node.definition.assetKey)),
  );
  const lastSelectedNode = selectedGraphNodes[selectedGraphNodes.length - 1]!;

  const selectedDefinitions = selectedGraphNodes.map((a) => a.definition);
  const allDefinitionsForMaterialize = Object.values(assetGraphData.nodes).map((a) => a.definition);

  const onSelectNode = React.useCallback(
    async (
      e: React.MouseEvent<any> | React.KeyboardEvent<any>,
      assetKey: {path: string[]},
      node: GraphNode | null,
    ) => {
      e.stopPropagation();

      const token = tokenForAssetKey(assetKey);
      const nodeIsInDisplayedGraph = node?.definition;

      if (!nodeIsInDisplayedGraph) {
        // The asset's definition was not provided in our query for job.assetNodes. It's either
        // in another job or asset group, or is a source asset not defined in any repository.
        return onNavigateToSourceAssetNode(await findAssetLocation(assetKey));
      }

      // This asset is in a job and we can stay in the job graph explorer!
      // If it's in our current job, allow shift / meta multi-selection.
      let nextOpsNameSelection = token;

      if (e.shiftKey || e.metaKey) {
        // Meta key adds the node you clicked to your existing selection
        let tokensToAdd = [token];

        // Shift key adds the nodes between the node you clicked and your existing selection.
        // To better support clicking a bunch of leaves and extending selection, we try to reach
        // the new node from each node in your current selection until we find a path.
        if (e.shiftKey && selectedGraphNodes.length && node) {
          const reversed = [...selectedGraphNodes].reverse();
          for (const from of reversed) {
            const tokensInRange = assetKeyTokensInRange({from, to: node, graph: assetGraphData});
            if (tokensInRange.length) {
              tokensToAdd = tokensInRange;
              break;
            }
          }
        }

        const existing = explorerPath.opNames[0]!.split(',');
        nextOpsNameSelection = (
          existing.includes(token) ? without(existing, token) : uniq([...existing, ...tokensToAdd])
        ).join(',');
      }

      zoomToNode(nextOpsNameSelection[nextOpsNameSelection.length - 1]!);

      onChangeExplorerPath(
        {
          ...explorerPath,
          opNames: [nextOpsNameSelection],
          opsQuery: nodeIsInDisplayedGraph
            ? explorerPath.opsQuery
            : `${explorerPath.opsQuery},++"${token}"++`,
          pipelineName: explorerPath.pipelineName,
        },
        'replace',
      );
    },
    [
      explorerPath,
      onChangeExplorerPath,
      onNavigateToSourceAssetNode,
      findAssetLocation,
      selectedGraphNodes,
      assetGraphData,
      layout,
    ],
  );

  const zoomToNode = React.useCallback(
    (nodeId: string) => {
      const nextCenter = layout?.nodes[nodeId];
      if (nextCenter) {
        viewportEl.current?.zoomToSVGCoords(nextCenter.bounds.x, nextCenter.bounds.y, true);
      }
    },
    [viewportEl, layout],
  );

  const zoomToGroup = React.useCallback(
    (groupId: string, animate = true) => {
      if (!viewportEl.current) {
        return;
      }
      const groupBounds = layout && layout.groups[groupId]?.bounds;
      if (groupBounds) {
        const targetScale = viewportEl.current.scaleForSVGBounds(
          groupBounds.width,
          groupBounds.height,
        );
        viewportEl.current.zoomToSVGBox(
          groupBounds,
          animate,
          Math.min(viewportEl.current.state.scale, targetScale * 0.9),
        );
      }
    },
    [viewportEl, layout],
  );

  const [lastRenderedLayout, setLastRenderedLayout] = React.useState<AssetGraphLayout | null>(null);
  const renderingNewLayout = lastRenderedLayout !== layout;

  React.useEffect(() => {
    if (!renderingNewLayout || !layout || !viewportEl.current) {
      return;
    }
    // The first render where we have our layout and viewport, autocenter or
    // focus on the selected node. (If selection was specified in the URL).
    // Don't animate this change.
    if (
      focusGroupIdAfterLayoutRef.current &&
      layout.groups[focusGroupIdAfterLayoutRef.current]?.expanded
    ) {
      zoomToGroup(focusGroupIdAfterLayoutRef.current, false);
      focusGroupIdAfterLayoutRef.current = '';
    } else if (lastSelectedNode) {
      const layoutNode = layout.nodes[lastSelectedNode.id];
      if (layoutNode) {
        viewportEl.current.zoomToSVGBox(layoutNode.bounds, false);
      }
      viewportEl.current.focus();
    } else {
      viewportEl.current.autocenter(false);
    }
    setLastRenderedLayout(layout);
  }, [renderingNewLayout, lastSelectedNode, layout, viewportEl, zoomToGroup]);

  const onClickBackground = () =>
    onChangeExplorerPath(
      {...explorerPath, pipelineName: explorerPath.pipelineName, opNames: []},
      'replace',
    );

  const onArrowKeyDown = (e: React.KeyboardEvent<any>, dir: 'left' | 'right' | 'up' | 'down') => {
    if (!layout || !lastSelectedNode) {
      return;
    }
    const hasDefinition = (node: {id: string}) => !!assetGraphData.nodes[node.id]?.definition;
    const layoutWithoutExternalLinks = {...layout, nodes: pickBy(layout.nodes, hasDefinition)};

    const nextId = closestNodeInDirection(layoutWithoutExternalLinks, lastSelectedNode.id, dir);
    selectNodeById(e, nextId);
  };

  const toggleSelectAllGroupNodesById = React.useCallback(
    (e: React.MouseEvent<any> | React.KeyboardEvent<any>, groupId: string) => {
      const assets = groupedAssets[groupId] || [];
      const childNodeTokens = assets.map((n) => tokenForAssetKey(n.assetKey));

      const existing = explorerPath.opNames[0]!.split(',');

      const nextOpsNameSelection = childNodeTokens.every((token) => existing.includes(token))
        ? uniq(without(existing, ...childNodeTokens)).join(',')
        : uniq([...existing, ...childNodeTokens]).join(',');

      onChangeExplorerPath(
        {
          ...explorerPath,
          opNames: [nextOpsNameSelection],
        },
        'replace',
      );
    },
    [groupedAssets, explorerPath, onChangeExplorerPath],
  );

  const selectNodeById = React.useCallback(
    (e: React.MouseEvent<any> | React.KeyboardEvent<any>, nodeId?: string) => {
      if (!nodeId) {
        return;
      }
      if (isGroupId(nodeId)) {
        zoomToGroup(nodeId);

        if (e.metaKey) {
          toggleSelectAllGroupNodesById(e, nodeId);
        }

        return;
      }
      const node = assetGraphData.nodes[nodeId];
      if (!node) {
        return;
      }

      onSelectNode(e, node.assetKey, node);

      const nodeBounds = layout && layout.nodes[nodeId]?.bounds;
      if (nodeBounds && viewportEl.current) {
        viewportEl.current.zoomToSVGBox(nodeBounds, true);
      } else {
        setExpandedGroups([...expandedGroups, groupIdForNode(node)]);
      }
    },
    [
      assetGraphData.nodes,
      onSelectNode,
      layout,
      zoomToGroup,
      toggleSelectAllGroupNodesById,
      setExpandedGroups,
      expandedGroups,
    ],
  );

  const [showSidebar, setShowSidebar] = React.useState(isGlobalGraph);

  const toggleGroupsButton = allGroups.length > 1 && (
    <ShortcutHandler
      key="toggle-groups"
      shortcutLabel="⌥E"
      onShortcut={() => setExpandedGroups(expandedGroups.length === 0 ? allGroups : [])}
      shortcutFilter={(e) => e.altKey && e.code === 'KeyE'}
    >
      {expandedGroups.length === 0 ? (
        <Tooltip
          content={
            <Box flex={{direction: 'row', gap: 4, alignItems: 'center'}}>
              Expand all groups <KeyboardTag $withinTooltip>⌥E</KeyboardTag>
            </Box>
          }
        >
          <Button
            title="Expand all groups"
            icon={<Icon name="unfold_more" />}
            onClick={() => setExpandedGroups(allGroups)}
            style={{background: Colors.backgroundDefault()}}
          />
        </Tooltip>
      ) : (
        <Tooltip
          content={
            <Box flex={{direction: 'row', gap: 4, alignItems: 'center'}}>
              Collapse all groups <KeyboardTag $withinTooltip>⌥E</KeyboardTag>
            </Box>
          }
        >
          <Button
            title="Collapse all groups"
            icon={<Icon name="unfold_less" />}
            onClick={() => setExpandedGroups([])}
            style={{background: Colors.backgroundDefault()}}
          />
        </Tooltip>
      )}
    </ShortcutHandler>
  );

  const onFilterToGroup = (group: GroupLayout) => {
    setFilters?.({
      ...filters,
      groups: [
        {
          groupName: group.groupName,
          repositoryName: group.repositoryName,
          repositoryLocationName: group.repositoryLocationName,
        },
      ],
    });
  };

  const areAllGroupsCollapsed = expandedGroups.length === 0;
  const areAllGroupsExpanded = expandedGroups.length === allGroups.length;

  const svgViewport = layout ? (
    <SVGViewport
      ref={(r) => (viewportEl.current = r || undefined)}
      defaultZoom="zoom-to-fit-width"
      interactor={SVGViewport.Interactors.PanAndZoom}
      graphWidth={layout.width}
      graphHeight={layout.height}
      graphHasNoMinimumZoom={false}
      additionalToolbarElements={toggleGroupsButton}
      onClick={onClickBackground}
      onArrowKeyDown={onArrowKeyDown}
      onDoubleClick={(e) => {
        viewportEl.current?.autocenter(true);
        e.stopPropagation();
      }}
      maxZoom={DEFAULT_MAX_ZOOM}
      maxAutocenterZoom={1}
    >
      {({scale}, viewportRect) => (
        <SVGContainer width={layout.width} height={layout.height}>
          {Object.values(layout.groups)
            .filter((node) => !isNodeOffscreen(node.bounds, viewportRect))
            .filter((group) => group.expanded)
            .sort((a, b) => a.id.length - b.id.length)
            .map((group) => (
              <foreignObject
                key={group.id}
                {...group.bounds}
                className="group"
                onDoubleClick={(e) => {
                  zoomToGroup(group.id);
                  e.stopPropagation();
                }}
              >
                <ExpandedGroupNode
                  setHighlighted={setHighlighted}
                  preferredJobName={explorerPath.pipelineName}
                  onFilterToGroup={() => onFilterToGroup(group)}
                  group={{
                    ...group,
                    assets: groupedAssets[group.id] || [],
                  }}
                  minimal={scale < MINIMAL_SCALE}
                  onCollapse={() => {
                    focusGroupIdAfterLayoutRef.current = group.id;
                    setExpandedGroups(expandedGroups.filter((g) => g !== group.id));
                  }}
                  toggleSelectAllNodes={(e: React.MouseEvent) => {
                    toggleSelectAllGroupNodesById(e, group.id);
                  }}
                />
              </foreignObject>
            ))}

          <AssetEdges
            viewportRect={viewportRect}
            selected={selectedGraphNodes.map((n) => n.id)}
            highlighted={highlighted}
            edges={layout.edges}
            strokeWidth={4}
          />

          {Object.values(layout.groups)
            .filter((node) => !isNodeOffscreen(node.bounds, viewportRect))
            .filter((group) => !group.expanded)
            .sort((a, b) => a.id.length - b.id.length)
            .map((group) => (
              <foreignObject
                key={group.id}
                {...group.bounds}
                className="group"
                onMouseEnter={() => setHighlighted([group.id])}
                onMouseLeave={() => setHighlighted(null)}
                onDoubleClick={(e) => {
                  if (!viewportEl.current) {
                    return;
                  }
                  const targetScale = viewportEl.current.scaleForSVGBounds(
                    group.bounds.width,
                    group.bounds.height,
                  );
                  viewportEl.current.zoomToSVGBox(group.bounds, true, targetScale * 0.9);
                  e.stopPropagation();
                }}
              >
                <CollapsedGroupNode
                  preferredJobName={explorerPath.pipelineName}
                  onFilterToGroup={() => onFilterToGroup(group)}
                  minimal={scale < MINIMAL_SCALE}
                  group={{
                    ...group,
                    assetCount: allGroupCounts[group.id] || 0,
                    assets: groupedAssets[group.id] || [],
                  }}
                  onExpand={() => {
                    focusGroupIdAfterLayoutRef.current = group.id;
                    setExpandedGroups([...expandedGroups, group.id]);
                  }}
                  toggleSelectAllNodes={(e: React.MouseEvent) => {
                    toggleSelectAllGroupNodesById(e, group.id);
                  }}
                />
              </foreignObject>
            ))}

          {Object.values(layout.nodes)
            .filter((node) => !isNodeOffscreen(node.bounds, viewportRect))
            .map(({id, bounds}) => {
              const graphNode = assetGraphData.nodes[id]!;
              const path = JSON.parse(id);
              if (scale < GROUPS_ONLY_SCALE) {
                return;
              }
              if (bounds.width === 1) {
                return;
              }

              const contextMenuProps = {
                graphData: fullAssetGraphData,
                node: graphNode,
                explorerPath,
                onChangeExplorerPath,
                selectNode: selectNodeById,
              };
              return (
                <foreignObject
                  {...bounds}
                  key={id}
                  onMouseEnter={() => setHighlighted([id])}
                  onMouseLeave={() => setHighlighted(null)}
                  onClick={(e) => onSelectNode(e, {path}, graphNode)}
                  onDoubleClick={(e) => {
                    viewportEl.current?.zoomToSVGBox(bounds, true, 1.2);
                    e.stopPropagation();
                  }}
                  style={{overflow: 'visible'}}
                >
                  {!graphNode ? (
                    <AssetNodeLink assetKey={{path}} />
                  ) : scale < MINIMAL_SCALE ? (
                    <AssetNodeContextMenuWrapper {...contextMenuProps}>
                      <AssetNodeMinimal
                        definition={graphNode.definition}
                        selected={selectedGraphNodes.includes(graphNode)}
                        height={bounds.height}
                      />
                    </AssetNodeContextMenuWrapper>
                  ) : (
                    <AssetNodeContextMenuWrapper {...contextMenuProps}>
                      <AssetNode
                        definition={graphNode.definition}
                        selected={selectedGraphNodes.includes(graphNode)}
                      />
                    </AssetNodeContextMenuWrapper>
                  )}
                </foreignObject>
              );
            })}
        </SVGContainer>
      )}
    </SVGViewport>
  ) : null;

  const panelInteractions = usePanelInteractions({resetTo: 65});

  const explorer = (
    <SplitPanelContainer
      key="explorer"
      axis="vertical"
      identifier="asset-graph-explorer"
      ref={panelInteractions.splitContainerRef}
      firstInitialPercent={65}
      firstMinSize={0}
      first={
        <ErrorBoundary region="graph">
          {graphQueryItems.length === 0 ? (
            <EmptyDAGNotice nodeType="asset" isGraph />
          ) : Object.keys(assetGraphData.nodes).length === 0 ? (
            <EntirelyFilteredDAGNotice nodeType="asset" />
          ) : undefined}
          {loading || !layout ? (
            <LoadingNotice async={async} nodeType="asset" />
          ) : allGroups.length > 1 ? (
            <ContextMenuWrapper
              wrapperOuterStyles={{width: '100%', height: '100%'}}
              wrapperInnerStyles={{width: '100%', height: '100%'}}
              menu={
                <Menu>
                  {areAllGroupsCollapsed ? null : (
                    <MenuItem
                      text={
                        <Box flex={{direction: 'row', gap: 4, alignItems: 'center'}}>
                          Collapse all groups <KeyboardTag>⌥E</KeyboardTag>
                        </Box>
                      }
                      icon={<Icon name="unfold_less" />}
                      onClick={() => {
                        setExpandedGroups([]);
                      }}
                    />
                  )}
                  {areAllGroupsExpanded ? null : (
                    <MenuItem
                      text={
                        <Box flex={{direction: 'row', gap: 4, alignItems: 'center'}}>
                          Expand all groups <KeyboardTag>⌥E</KeyboardTag>
                        </Box>
                      }
                      icon={<Icon name="unfold_more" />}
                      onClick={() => {
                        setExpandedGroups(allGroups);
                      }}
                    />
                  )}
                </Menu>
              }
            >
              {svgViewport}
            </ContextMenuWrapper>
          ) : (
            svgViewport
          )}
          {setOptions && (
            <OptionsOverlay>
              <Checkbox
                format="switch"
                label="View as Asset Graph"
                checked={options.preferAssetRendering}
                onChange={() => {
                  onChangeExplorerPath(
                    {...explorerPath, opNames: selectedDefinitions[0]?.opNames || []},
                    'replace',
                  );
                  setOptions({
                    ...options,
                    preferAssetRendering: !options.preferAssetRendering,
                  });
                }}
              />
            </OptionsOverlay>
          )}

          <TopbarWrapper>
            <Box flex={{direction: 'column'}} style={{width: '100%'}}>
              <Box
                border={filterBar ? 'bottom' : undefined}
                flex={{gap: 12, alignItems: 'center'}}
                padding={{left: showSidebar ? 12 : 24, vertical: 12, right: 12}}
              >
                {showSidebar ? undefined : (
                  <Tooltip content="Show sidebar">
                    <Button
                      icon={<Icon name="panel_show_left" />}
                      onClick={() => {
                        setShowSidebar(true);
                      }}
                    />
                  </Tooltip>
                )}
                <div>{filterButton}</div>
                <GraphQueryInputFlexWrap>
                  <GraphQueryInput
                    type="asset_graph"
                    items={graphQueryItems}
                    value={explorerPath.opsQuery}
                    placeholder="Type an asset subset…"
                    onChange={(opsQuery) =>
                      onChangeExplorerPath({...explorerPath, opsQuery}, 'replace')
                    }
                    popoverPosition="bottom-left"
                  />
                </GraphQueryInputFlexWrap>
                <AssetLiveDataRefresh />
                <LaunchAssetObservationButton
                  preferredJobName={explorerPath.pipelineName}
                  scope={
                    selectedDefinitions.length
                      ? {selected: selectedDefinitions.filter((a) => a.isObservable)}
                      : {all: allDefinitionsForMaterialize.filter((a) => a.isObservable)}
                  }
                />
                <LaunchAssetExecutionButton
                  preferredJobName={explorerPath.pipelineName}
                  scope={
                    selectedDefinitions.length
                      ? {selected: selectedDefinitions}
                      : {all: allDefinitionsForMaterialize}
                  }
                />
              </Box>
              {filterBar}
            </Box>
          </TopbarWrapper>
        </ErrorBoundary>
      }
      second={
        selectedGraphNodes.length === 1 && selectedGraphNodes[0] ? (
          <RightInfoPanel
            onWheel={(e) => {
              const scrollerEl = e.currentTarget.firstElementChild as HTMLElement;
              if (!scrollerEl) {
                return;
              }

              // If the panel is collapsed and you scroll down in it, expand it to full height.
              // Do not allow the user to scroll while the panel is expanding, since opening
              // feels like scrolling.
              if (e.deltaY > 0 && !panelInteractions.isBottomExpanded) {
                panelInteractions.expandBottomPanel();
                e.preventDefault();
                scrollerEl.scrollTop = 0;
                scrollerEl.style.overflowY = 'hidden';
                setTimeout(() => (scrollerEl.style.overflowY = 'auto'), SPLIT_PANEL_ANIMATION_MS);
              }
              // If the panel is expanded and you scroll up while already at the top, collapse the panel
              if (
                e.deltaY < 0 &&
                panelInteractions.isBottomExpanded &&
                scrollerEl.scrollTop === 0
              ) {
                e.preventDefault();
                panelInteractions.resetPanels();
              }
            }}
          >
            <ErrorBoundary region="asset sidebar" resetErrorOnChange={[selectedGraphNodes[0].id]}>
              <AssetView
                assetKey={selectedGraphNodes[0].assetKey}
                trayControlElement={
                  <ExpandCollapseButton
                    expanded={panelInteractions.isBottomExpanded}
                    onExpand={panelInteractions.expandBottomPanel}
                    onCollapse={() => {
                      panelInteractions.resetPanels();
                      if (selectedGraphNodes[0]) {
                        zoomToNode(selectedGraphNodes[0].id);
                      }
                    }}
                  />
                }
              />
            </ErrorBoundary>
          </RightInfoPanel>
        ) : fetchOptions.pipelineSelector ? (
          <RightInfoPanel>
            <RightInfoPanelContent>
              <ErrorBoundary region="asset job sidebar">
                <AssetGraphJobSidebar pipelineSelector={fetchOptions.pipelineSelector} />
              </ErrorBoundary>
            </RightInfoPanelContent>
          </RightInfoPanel>
        ) : null
      }
    />
  );

  if (showSidebar) {
    return (
      <SplitPanelContainer
        key="explorer-wrapper"
        identifier="explorer-wrapper"
        firstMinSize={300}
        firstInitialPercent={0}
        first={
          showSidebar ? (
            <AssetGraphExplorerSidebar
              isGlobalGraph={isGlobalGraph}
              allAssetKeys={allAssetKeys}
              assetGraphData={assetGraphData}
              fullAssetGraphData={fullAssetGraphData}
              selectedNodes={selectedGraphNodes}
              selectNode={selectNodeById}
              explorerPath={explorerPath}
              onChangeExplorerPath={onChangeExplorerPath}
              expandedGroups={expandedGroups}
              setExpandedGroups={setExpandedGroups}
              hideSidebar={() => {
                setShowSidebar(false);
              }}
            />
          ) : null
        }
        second={explorer}
      />
    );
  }
  return explorer;
};
