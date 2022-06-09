/* eslint-disable max-classes-per-file */
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Router } from '@angular/router';

import { Store } from '@ngrx/store';
import { RemoveOperation, ReplaceOperation } from 'fast-json-patch';
import { combineLatest, Observable } from 'rxjs';
import { find, map, switchMap } from 'rxjs/operators';

import { environment } from '../../../environments/environment';
import { NotificationsService } from '../../shared/notifications/notifications.service';
import { dataService } from '../cache/builders/build-decorators';
import { RemoteDataBuildService } from '../cache/builders/remote-data-build.service';
import { ObjectCacheService } from '../cache/object-cache.service';
import { ConfigurationDataService } from '../data/configuration-data.service';
import { DataService } from '../data/data.service';
import { DefaultChangeAnalyzer } from '../data/default-change-analyzer.service';
import { ItemDataService } from '../data/item-data.service';
import { RemoteData } from '../data/remote-data';
import { RequestService } from '../data/request.service';
import { ConfigurationProperty } from '../shared/configuration-property.model';
import { HALEndpointService } from '../shared/hal-endpoint.service';
import { NoContent } from '../shared/NoContent.model';
import {
  getAllCompletedRemoteData,
  getFinishedRemoteData,
  getFirstCompletedRemoteData,
  getFirstSucceededRemoteDataPayload
} from '../shared/operators';
import { ResearcherProfile } from './model/researcher-profile.model';
import { RESEARCHER_PROFILE } from './model/researcher-profile.resource-type';
import { HttpOptions } from '../dspace-rest/dspace-rest.service';
import { PostRequest } from '../data/request.models';
import { hasValue } from '../../shared/empty.util';
import { CoreState } from '../core-state.model';
import { followLink, FollowLinkConfig } from '../../shared/utils/follow-link-config.model';
import { Item } from '../shared/item.model';

/**
 * A private DataService implementation to delegate specific methods to.
 */
class ResearcherProfileServiceImpl extends DataService<ResearcherProfile> {
  protected linkPath = 'profiles';

  constructor(
    protected requestService: RequestService,
    protected rdbService: RemoteDataBuildService,
    protected store: Store<CoreState>,
    protected objectCache: ObjectCacheService,
    protected halService: HALEndpointService,
    protected notificationsService: NotificationsService,
    protected http: HttpClient,
    protected comparator: DefaultChangeAnalyzer<ResearcherProfile>) {
    super();
  }

}

/**
 * A service that provides methods to make REST requests with researcher profile endpoint.
 */
@Injectable()
@dataService(RESEARCHER_PROFILE)
export class ResearcherProfileService {

  dataService: ResearcherProfileServiceImpl;

  responseMsToLive: number = 10 * 1000;

  constructor(
    protected requestService: RequestService,
    protected rdbService: RemoteDataBuildService,
    protected objectCache: ObjectCacheService,
    protected halService: HALEndpointService,
    protected notificationsService: NotificationsService,
    protected http: HttpClient,
    protected router: Router,
    protected comparator: DefaultChangeAnalyzer<ResearcherProfile>,
    protected itemService: ItemDataService,
    protected configurationService: ConfigurationDataService) {

    this.dataService = new ResearcherProfileServiceImpl(requestService, rdbService, null, objectCache, halService,
      notificationsService, http, comparator);

  }

  /**
   * Find the researcher profile with the given uuid.
   *
   * @param uuid the profile uuid
   * @param useCachedVersionIfAvailable If this is true, the request will only be sent if there's
   *                                    no valid cached version. Defaults to true
   * @param reRequestOnStale            Whether or not the request should automatically be re-
   *                                    requested after the response becomes stale
   * @param linksToFollow               List of {@link FollowLinkConfig} that indicate which
   *                                    {@link HALLink}s should be automatically resolved
   */
  public findById(uuid: string, useCachedVersionIfAvailable = true, reRequestOnStale = true, ...linksToFollow: FollowLinkConfig<ResearcherProfile>[]): Observable<RemoteData<ResearcherProfile>> {
    return this.dataService.findById(uuid, useCachedVersionIfAvailable, reRequestOnStale, ...linksToFollow).pipe(
      getAllCompletedRemoteData(),
    );
  }

  /**
   * Create a new researcher profile for the current user.
   */
  public create(): Observable<RemoteData<ResearcherProfile>> {
    return this.dataService.create(new ResearcherProfile());
  }

  /**
   * Delete a researcher profile.
   *
   * @param researcherProfile the profile to delete
   */
  public delete(researcherProfile: ResearcherProfile): Observable<boolean> {
    return this.dataService.delete(researcherProfile.id).pipe(
      getFirstCompletedRemoteData(),
      map((response: RemoteData<NoContent>) => response.isSuccess)
    );
  }

  /**
   * Find the item id related to the given researcher profile.
   *
   * @param researcherProfile the profile to find for
   */
  public findRelatedItemId(researcherProfile: ResearcherProfile): Observable<string> {
    const relatedItem$ = researcherProfile.item ? researcherProfile.item : this.itemService.findByHref(researcherProfile._links.item.href, false);
    return relatedItem$.pipe(
      getFirstCompletedRemoteData(),
      map((itemRD: RemoteData<Item>) => (itemRD.hasSucceeded && itemRD.payload) ? itemRD.payload.id : null)
    );
  }

  /**
   * Change the visibility of the given researcher profile setting the given value.
   *
   * @param researcherProfile the profile to update
   * @param visible the visibility value to set
   */
  public setVisibility(researcherProfile: ResearcherProfile, visible: boolean): Observable<RemoteData<ResearcherProfile>> {
    const replaceOperation: ReplaceOperation<boolean> = {
      path: '/visible',
      op: 'replace',
      value: visible
    };

    return this.dataService.patch(researcherProfile, [replaceOperation]);
  }

  /**
   * Check if the given item is linked to an ORCID profile.
   *
   * @param item the item to check
   * @returns the check result
   */
  isLinkedToOrcid(item: Item): boolean {
    return item.hasMetadata('dspace.orcid.authenticated');
  }

  /**
   * Returns true if only the admin users can disconnect a researcher profile from ORCID.
   *
   * @returns the check result
   */
  onlyAdminCanDisconnectProfileFromOrcid(): Observable<boolean> {
    return this.getOrcidDisconnectionAllowedUsersConfiguration().pipe(
      map((property) => property.values.map( (value) => value.toLowerCase()).includes('only_admin'))
    );
  }

  /**
   * Returns true if the profile's owner can disconnect that profile from ORCID.
   *
   * @returns the check result
   */
  ownerCanDisconnectProfileFromOrcid(): Observable<boolean> {
    return this.getOrcidDisconnectionAllowedUsersConfiguration().pipe(
      map((property) => {
        const values = property.values.map( (value) => value.toLowerCase());
        return values.includes('only_owner') || values.includes('admin_and_owner');
      })
    );
  }

  /**
   * Returns true if the admin users can disconnect a researcher profile from ORCID.
   *
   * @returns the check result
   */
  adminCanDisconnectProfileFromOrcid(): Observable<boolean> {
    return this.getOrcidDisconnectionAllowedUsersConfiguration().pipe(
      map((property) => {
        const values = property.values.map( (value) => value.toLowerCase());
        return values.includes('only_admin') || values.includes('admin_and_owner');
      })
    );
  }

  /**
   * If the given item represents a profile unlink it from ORCID.
   */
  unlinkOrcid(item: Item): Observable<RemoteData<ResearcherProfile>> {

    const operations: RemoveOperation[] = [{
      path:'/orcid',
      op:'remove'
    }];

    return this.findById(item.firstMetadata('dspace.object.owner').authority).pipe(
      getFirstCompletedRemoteData(),
      switchMap((profileRD) => this.dataService.patch(profileRD.payload, operations)),
      getFinishedRemoteData()
    );
  }

  getOrcidAuthorizeUrl(profile: Item): Observable<string> {
    return combineLatest([
      this.configurationService.findByPropertyName('orcid.authorize-url').pipe(getFirstSucceededRemoteDataPayload()),
      this.configurationService.findByPropertyName('orcid.application-client-id').pipe(getFirstSucceededRemoteDataPayload()),
      this.configurationService.findByPropertyName('orcid.scope').pipe(getFirstSucceededRemoteDataPayload())]
    ).pipe(
      map(([authorizeUrl, clientId, scopes]) => {
        const redirectUri = environment.rest.baseUrl + '/api/eperson/orcid/' + profile.id + '/?url=' + encodeURIComponent(this.router.url);
        return authorizeUrl.values[0] + '?client_id=' + clientId.values[0]   + '&redirect_uri=' + redirectUri + '&response_type=code&scope='
          + scopes.values.join(' ');
      }));
  }

  /**
   * Creates a researcher profile starting from an external source URI
   * @param sourceUri URI of source item of researcher profile.
   */
  public createFromExternalSource(sourceUri: string): Observable<RemoteData<ResearcherProfile>> {
    const options: HttpOptions = Object.create({});
    let headers = new HttpHeaders();
    headers = headers.append('Content-Type', 'text/uri-list');
    options.headers = headers;

    const requestId = this.requestService.generateRequestId();
    const href$ = this.halService.getEndpoint(this.dataService.getLinkPath());

    href$.pipe(
      find((href: string) => hasValue(href)),
      map((href: string) => this.dataService.buildHrefWithParams(href, [], followLink('item')))
    ).subscribe((endpoint: string) => {
      const request = new PostRequest(requestId, endpoint, sourceUri, options);
      this.requestService.send(request);
    });

    return this.rdbService.buildFromRequestUUID(requestId, followLink('item'));
  }

  private getOrcidDisconnectionAllowedUsersConfiguration(): Observable<ConfigurationProperty> {
    return this.configurationService.findByPropertyName('orcid.disconnection.allowed-users').pipe(
      getFirstSucceededRemoteDataPayload()
    );
  }

}
