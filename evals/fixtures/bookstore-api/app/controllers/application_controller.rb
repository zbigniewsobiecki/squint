class ApplicationController < ActionController::API
  before_action :set_request_id

  private

  def current_user
    return @current_user if defined?(@current_user)

    token = request.headers['Authorization']&.split(' ')&.last
    @current_user = token ? User.find_by(auth_token: token) : nil
  end

  def authenticate!
    render json: { error: 'Unauthorized' }, status: :unauthorized unless current_user
  end

  def set_request_id
    Thread.current[:request_id] = request.request_id
  end
end
